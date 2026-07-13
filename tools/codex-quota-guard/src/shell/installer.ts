import { randomUUID } from "node:crypto"
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
} from "node:fs/promises"
import path from "node:path"
import { assertInteractiveCapabilities } from "../cli-runtime.js"
import type {
  GlobalConfigStore,
  GlobalGuardConfig,
  SupportedShell,
} from "../persistence/global-config-store.js"
import type { RuntimeContext } from "../runtime/runtime-context.js"
import { sanitizeDiagnostic } from "../persistence/state-store.js"
import type { CurrentShell } from "./current-shell.js"
import {
  addProfileBlock,
  inspectProfile,
  removeProfileBlock,
} from "./profile-block.js"
import {
  renderShim,
  shimFileName,
  type ShimEntry,
  type ShimTemplateOptions,
  verifyShim,
} from "./shim-template.js"

export interface ShellInstallerOptions {
  rootDirectory: string
  globalStore: GlobalConfigStore
  nodeExecutable: string
  cliEntry: string
  platform: NodeJS.Platform
  home: string
  detectShell(): Promise<CurrentShell>
  isTTY: boolean
  confirm(prompt: string): Promise<string>
  writeOutput(line: string): void
  verifyInstallation(details: ShellVerificationDetails): Promise<void>
  currentPath?: string
  inspectRealCodexVersion?(codexPath: string): Promise<string>
}

export interface ShellVerificationDetails {
  shell: SupportedShell
  profilePath: string
  shimDirectory: string
  realCodexExecutable: string
}

export type ShellOperationStatus =
  | "installed"
  | "already-installed"
  | "uninstalled"
  | "already-uninstalled"

export interface ShellOperationResult {
  status: ShellOperationStatus
  shell?: SupportedShell
  profilePath?: string
  shimDirectory?: string
  healthy?: boolean
  issues?: string[]
  observedCodexVersion?: string
}

interface FileSnapshot {
  path: string
  exists: boolean
  content: Buffer
  mode: number | null
}

const ENTRIES: ShimEntry[] = ["codex", "codex-raw"]

export class ShellInstaller {
  constructor(private readonly options: ShellInstallerOptions) {
    void options.rootDirectory
    void options.home
  }

  async status(): Promise<ShellOperationResult> {
    const config = await this.options.globalStore.load()
    if (!config.shellIntegration.enabled || !config.shellIntegration.shimDirectory) {
      return { status: "already-uninstalled" }
    }
    const current = await this.options.detectShell()
    const registered = config.shellIntegration.shells.some((entry) => (
      entry.shell === current.shell && entry.profilePath === current.profilePath
    ))
    if (!registered) return { status: "already-uninstalled", ...current }
    const shimDirectory = config.shellIntegration.shimDirectory
    const issues: string[] = []
    const profileSnapshot = await captureFile(current.profilePath)
    const profileContent = profileSnapshot.exists
      ? profileSnapshot.content.toString("utf8")
      : ""
    const profileStatus = inspectProfile(
      profileContent,
      current.shell,
      shimDirectory,
    ).status
    if (profileStatus !== "managed") {
      issues.push(`profile 标记块状态=${profileStatus}`)
    }
    const shimOptions = this.shimOptions()
    for (const entry of ENTRIES) {
      const shimPath = path.join(
        shimDirectory,
        shimFileName(entry, this.options.platform),
      )
      const snapshot = await captureFile(shimPath)
      if (!snapshot.exists) {
        issues.push(`${entry} shim 缺失`)
      } else if (!verifyShim(snapshot.content.toString("utf8"), shimOptions(entry))) {
        issues.push(`${entry} shim checksum 或内容不匹配`)
      }
    }
    if (!config.realCodexExecutable || !config.realCodexVersion) {
      issues.push("保存的真实 Codex 路径或版本缺失")
    }
    let observedCodexVersion: string | undefined
    if (config.realCodexExecutable && this.options.inspectRealCodexVersion) {
      try {
        observedCodexVersion = await this.options.inspectRealCodexVersion(
          config.realCodexExecutable,
        )
        if (config.realCodexVersion && observedCodexVersion !== config.realCodexVersion) {
          issues.push(
            `真实 Codex 版本漂移：保存=${config.realCodexVersion}，实测=${observedCodexVersion}`,
          )
        }
      } catch (error) {
        issues.push(`真实 Codex 版本检查失败：${errorMessage(error)}`)
      }
    }
    const currentPath = this.options.currentPath ?? process.env.PATH ?? ""
    const delimiter = this.options.platform === "win32" ? ";" : ":"
    const firstPath = currentPath.split(delimiter).find(Boolean)
    if (!firstPath || !samePath(firstPath, shimDirectory, this.options.platform)) {
      issues.push("当前 PATH 未把受管 shim 目录置于首位")
    }
    return {
      status: "already-installed",
      ...current,
      shimDirectory,
      healthy: issues.length === 0,
      issues,
      observedCodexVersion,
    }
  }

  async install(context: RuntimeContext): Promise<ShellOperationResult> {
    assertInteractiveCapabilities(context, this.options.platform)
    const realCodexExecutable = context.executable.codexExecutableRealPath
    if (!context.executable.launchAllowed || !realCodexExecutable) {
      throw new Error("无法安装：尚未明确解析真实 Codex 可执行文件")
    }

    const current = await this.options.detectShell()
    const config = await this.options.globalStore.load()
    const shimDirectory = config.shellIntegration.shimDirectory
      ?? path.join(this.options.globalStore.configDirectory, "shims")
    const shimOptions = this.shimOptions()
    const shimPaths = ENTRIES.map((entry) => path.join(
      shimDirectory,
      shimFileName(entry, this.options.platform),
    ))
    if (samePath(realCodexExecutable, this.options.cliEntry, this.options.platform)
      || shimPaths.some((shimPath) => samePath(
        realCodexExecutable,
        shimPath,
        this.options.platform,
      ))) {
      throw new Error("真实 Codex 指向 Guard 或受管 shim，会造成递归调用")
    }
    const profileSnapshot = await captureFile(current.profilePath)
    const profileContent = profileSnapshot.exists
      ? profileSnapshot.content.toString("utf8")
      : ""
    const inspection = inspectProfile(
      profileContent,
      current.shell,
      shimDirectory,
    )
    if (inspection.status !== "absent" && inspection.status !== "managed") {
      throw new Error(`profile 标记块冲突：${inspection.status}`)
    }

    const shimSnapshots = await Promise.all(shimPaths.map(captureFile))
    for (const [index, snapshot] of shimSnapshots.entries()) {
      if (!snapshot.exists) continue
      const entry = ENTRIES[index]
      if (!verifyShim(snapshot.content.toString("utf8"), shimOptions(entry))) {
        throw new Error(`shim 冲突，拒绝覆盖未知文件：${snapshot.path}`)
      }
    }

    const registered = config.shellIntegration.shells.some((entry) => (
      entry.shell === current.shell && entry.profilePath === current.profilePath
    ))
    if (registered
      && inspection.status === "managed"
      && shimSnapshots.every((snapshot) => snapshot.exists)
      && config.realCodexExecutable === realCodexExecutable
      && config.realCodexVersion === context.executable.codexVersion) {
      return {
        status: "already-installed",
        ...current,
        shimDirectory,
      }
    }
    if (!this.options.isTTY) {
      throw new Error("shell install 只允许在交互式 TTY 中修改配置")
    }

    this.describeInstall(current, shimDirectory, realCodexExecutable, shimPaths)
    if (await this.options.confirm("输入 INSTALL 确认安装：") !== "INSTALL") {
      throw new Error("shell install 已取消")
    }

    const configSnapshot = await captureFile(this.options.globalStore.configPath)
    try {
      await mkdir(shimDirectory, { recursive: true, mode: 0o700 })
      for (const entry of ENTRIES) {
        const destination = path.join(
          shimDirectory,
          shimFileName(entry, this.options.platform),
        )
        await atomicWriteFile(destination, renderShim(shimOptions(entry)), 0o755)
      }
      const installedProfile = addProfileBlock(
        profileContent,
        current.shell,
        shimDirectory,
      )
      await atomicWriteFile(current.profilePath, installedProfile, profileSnapshot.mode ?? 0o600)

      const next = structuredClone(config)
      next.realCodexExecutable = realCodexExecutable
      next.realCodexVersion = context.executable.codexVersion
      next.shellIntegration.enabled = true
      next.shellIntegration.shimDirectory = shimDirectory
      next.shellIntegration.installedAt ??= new Date().toISOString()
      if (!registered) {
        next.shellIntegration.shells.push({
          ...current,
          profileOriginallyExisted: profileSnapshot.exists,
        })
      }
      await this.options.globalStore.save(next)

      await this.options.verifyInstallation({
        ...current,
        shimDirectory,
        realCodexExecutable,
      })
    } catch (error) {
      await restoreAll([...shimSnapshots, profileSnapshot, configSnapshot])
      throw error
    }

    return { status: "installed", ...current, shimDirectory }
  }

  async uninstall(): Promise<ShellOperationResult> {
    const config = await this.options.globalStore.load()
    if (!config.shellIntegration.enabled || !config.shellIntegration.shimDirectory) {
      return { status: "already-uninstalled" }
    }
    const current = await this.options.detectShell()
    const registeredIndex = config.shellIntegration.shells.findIndex((entry) => (
      entry.shell === current.shell && entry.profilePath === current.profilePath
    ))
    if (registeredIndex === -1) {
      return { status: "already-uninstalled", ...current }
    }
    if (!this.options.isTTY) {
      throw new Error("shell uninstall 只允许在交互式 TTY 中修改配置")
    }

    const shimDirectory = config.shellIntegration.shimDirectory
    const profileSnapshot = await captureFile(current.profilePath)
    const profileContent = profileSnapshot.exists
      ? profileSnapshot.content.toString("utf8")
      : ""
    const inspection = inspectProfile(profileContent, current.shell, shimDirectory)
    if (inspection.status !== "managed") {
      throw new Error(`profile 标记块冲突：${inspection.status}`)
    }

    const lastShell = config.shellIntegration.shells.length === 1
    const shimOptions = this.shimOptions()
    const shimPaths = ENTRIES.map((entry) => path.join(
      shimDirectory,
      shimFileName(entry, this.options.platform),
    ))
    const shimSnapshots = await Promise.all(shimPaths.map(captureFile))
    if (lastShell) {
      for (const [index, snapshot] of shimSnapshots.entries()) {
        if (!snapshot.exists || !verifyShim(
          snapshot.content.toString("utf8"),
          shimOptions(ENTRIES[index]),
        )) {
          throw new Error(`受管 shim 已缺失或被修改，拒绝删除：${snapshot.path}`)
        }
      }
    }

    this.describeUninstall(current, shimDirectory, lastShell ? shimPaths : [])
    if (await this.options.confirm("输入 UNINSTALL 确认卸载：") !== "UNINSTALL") {
      throw new Error("shell uninstall 已取消")
    }

    const configSnapshot = await captureFile(this.options.globalStore.configPath)
    const restoredProfile = removeProfileBlock(
      profileContent,
      current.shell,
      shimDirectory,
    )
    const profileOriginallyExisted = config.shellIntegration
      .shells[registeredIndex]
      ?.profileOriginallyExisted
    try {
      if (profileOriginallyExisted === false && restoredProfile.length === 0) {
        await rm(current.profilePath)
      } else {
        await atomicWriteFile(
          current.profilePath,
          restoredProfile,
          profileSnapshot.mode ?? 0o600,
        )
      }
      if (lastShell) {
        await Promise.all(shimPaths.map(async (shimPath) => await rm(shimPath)))
        await rmdir(shimDirectory)
      }
      const next = withoutShell(config, registeredIndex, lastShell)
      await this.options.globalStore.save(next)
    } catch (error) {
      await restoreAll([...shimSnapshots, profileSnapshot, configSnapshot])
      throw error
    }

    return { status: "uninstalled", ...current, shimDirectory }
  }

  private shimOptions(): (entry: ShimEntry) => ShimTemplateOptions {
    return (entry) => ({
      platform: this.options.platform,
      nodeExecutable: this.options.nodeExecutable,
      cliEntry: this.options.cliEntry,
      entry,
    })
  }

  private describeInstall(
    current: CurrentShell,
    shimDirectory: string,
    realCodexExecutable: string,
    shimPaths: string[],
  ): void {
    this.options.writeOutput([
      "将安装当前 shell 的 Codex Quota Guard 集成：",
      `当前 shell：${current.shell}`,
      `将修改 profile：${current.profilePath}`,
      `将写入 shim 目录：${shimDirectory}`,
      ...shimPaths.map((shimPath) => `将写入：${shimPath}`),
      `将写入全局配置：${this.options.globalStore.configPath}`,
      `真实 Codex：${realCodexExecutable}`,
    ].join("\n"))
  }

  private describeUninstall(
    current: CurrentShell,
    shimDirectory: string,
    shimPaths: string[],
  ): void {
    this.options.writeOutput([
      "将卸载当前 shell 的 Codex Quota Guard 集成：",
      `当前 shell：${current.shell}`,
      `将修改 profile：${current.profilePath}`,
      `shim 目录：${shimDirectory}`,
      ...shimPaths.map((shimPath) => `将删除：${shimPath}`),
    ].join("\n"))
  }
}

function withoutShell(
  config: GlobalGuardConfig,
  registeredIndex: number,
  lastShell: boolean,
): GlobalGuardConfig {
  const next = structuredClone(config)
  next.shellIntegration.shells.splice(registeredIndex, 1)
  if (lastShell) {
    next.shellIntegration.enabled = false
    next.shellIntegration.shimDirectory = null
    next.shellIntegration.installedAt = null
    next.realCodexExecutable = null
    next.realCodexVersion = null
  }
  return next
}

async function captureFile(filePath: string): Promise<FileSnapshot> {
  try {
    const [content, metadata] = await Promise.all([readFile(filePath), stat(filePath)])
    return {
      path: filePath,
      exists: true,
      content,
      mode: metadata.mode & 0o777,
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { path: filePath, exists: false, content: Buffer.alloc(0), mode: null }
    }
    throw error
  }
}

async function restoreAll(snapshots: FileSnapshot[]): Promise<void> {
  const failures: unknown[] = []
  for (const snapshot of [...snapshots].reverse()) {
    try {
      await restoreFile(snapshot)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "shell 安装回滚不完整")
  }
}

async function restoreFile(snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.exists) {
    await rm(snapshot.path, { force: true })
    return
  }
  await atomicWriteFile(snapshot.path, snapshot.content, snapshot.mode ?? 0o600)
}

async function atomicWriteFile(
  destination: string,
  content: string | Buffer,
  mode: number,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, "wx", mode)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, destination)
    if (process.platform !== "win32") await chmod(destination, mode)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function errorMessage(error: unknown): string {
  return sanitizeDiagnostic(error instanceof Error ? error.message : String(error))
}

function samePath(first: string, second: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => {
    const normalized = platform === "win32"
      ? path.win32.resolve(value)
      : path.posix.resolve(value)
    return platform === "win32" ? normalized.toLowerCase() : normalized
  }
  return normalize(first) === normalize(second)
}
