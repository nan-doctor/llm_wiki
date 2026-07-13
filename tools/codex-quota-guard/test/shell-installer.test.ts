import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildCapabilityMatrix, emptyCapabilities } from "../src/runtime/capabilities.js"
import type { RuntimeContext } from "../src/runtime/runtime-context.js"
import { GlobalConfigStore } from "../src/persistence/global-config-store.js"
import {
  renderShim,
  shimFileName,
  verifyShim,
} from "../src/shell/shim-template.js"
import { ShellInstaller } from "../src/shell/installer.js"

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-shell-installer-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })))
})

function context(codexPath: string): RuntimeContext {
  const schema = emptyCapabilities()
  schema.rateLimitsRead = true
  schema.rateLimitsUpdated = true
  schema.turnStart = true
  schema.turnInterrupt = true
  schema.threadRead = true
  return {
    executable: {
      codexExecutable: codexPath,
      codexExecutableRealPath: codexPath,
      codexVersion: "codex-cli 1.0.0",
      executableSelectionSource: "cli",
      launchAllowed: true,
      discoveredCandidates: [],
    },
    protocolFingerprint: "fingerprint",
    schemaCapabilities: schema,
    capabilityMatrix: buildCapabilityMatrix(schema),
    remoteCapabilities: {
      remoteTui: true,
      remoteAuthTokenEnv: true,
      remoteUnixSocket: true,
      remoteLoopbackWebSocket: true,
      appServerStdio: true,
    },
  }
}

async function harness(options: {
  isTTY?: boolean
  confirmation?: string
  verify?: () => Promise<void>
  currentPath?: string
} = {}) {
  const root = await temporaryRoot()
  const home = path.join(root, "home with spaces")
  await mkdir(home, { recursive: true })
  const profilePath = path.join(home, ".zshrc")
  const otherProfile = path.join(home, ".bashrc")
  await writeFile(profilePath, "export USER_SETTING=1", "utf8")
  await writeFile(otherProfile, "export BASH_ONLY=1", "utf8")
  const codexPath = path.join(root, "real codex")
  const cliEntry = path.join(root, "guard cli.js")
  await writeFile(codexPath, "fake", { mode: 0o755 })
  await chmod(codexPath, 0o755)
  await writeFile(cliEntry, "fake", "utf8")
  const globalStore = new GlobalConfigStore({ platform: "darwin", home })
  const shimDirectory = path.join(globalStore.configDirectory, "shims")
  const output: string[] = []
  let confirmation = options.confirmation ?? "INSTALL"
  const installer = new ShellInstaller({
    rootDirectory: root,
    globalStore,
    nodeExecutable: process.execPath,
    cliEntry,
    platform: "darwin",
    home,
    detectShell: async () => ({ shell: "zsh", profilePath }),
    isTTY: options.isTTY ?? true,
    confirm: async () => confirmation,
    writeOutput: (line) => output.push(line),
    verifyInstallation: options.verify ?? (async () => undefined),
    currentPath: options.currentPath ?? `${shimDirectory}:/usr/bin:/bin`,
  })
  return {
    root,
    home,
    profilePath,
    otherProfile,
    codexPath,
    cliEntry,
    globalStore,
    output,
    installer,
    setConfirmation(value: string) { confirmation = value },
  }
}

describe("shim 模板", () => {
  it.each(["codex", "codex-raw"] as const)("POSIX %s shim 可校验且安全引用空格路径", (entry) => {
    const options = {
      platform: "darwin" as const,
      nodeExecutable: "/path with spaces/node",
      cliEntry: "/path with spaces/guard cli.js",
      entry,
    }
    const content = renderShim(options)

    expect(content).toContain("codex-quota-guard-shim")
    expect(content).toContain("format=1")
    expect(content).toContain(`entry=${entry}`)
    expect(content).toMatch(/checksum=[a-f0-9]{64}/)
    expect(content).toContain("'/path with spaces/node'")
    const checksum = /checksum=([a-f0-9]{64})/.exec(content)?.[1]
    const canonical = content.replace(/^# checksum=[a-f0-9]{64}\n/m, "")
    expect(checksum).toBe(createHash("sha256").update(canonical).digest("hex"))
    expect(verifyShim(content, options)).toBe(true)
    expect(verifyShim(`${content}# user edit\n`, options)).toBe(false)
  })

  it("Windows shim 使用 .cmd 和参数数组边界", () => {
    const options = {
      platform: "win32" as const,
      nodeExecutable: "C:\\Program Files\\node.exe",
      cliEntry: "C:\\Guard Tool\\cli.js",
      entry: "codex" as const,
    }
    const content = renderShim(options)
    expect(shimFileName("codex", "win32")).toBe("codex.cmd")
    expect(content).toContain('"C:\\Program Files\\node.exe"')
    expect(content).toContain("%*")
    expect(verifyShim(content, options)).toBe(true)
  })
})

describe("ShellInstaller", () => {
  it("只修改当前 zsh、安装两份 shim、保存真实 Codex 并保持幂等", async () => {
    const test = await harness()
    const bashBefore = await readFile(test.otherProfile, "utf8")

    await expect(test.installer.install(context(test.codexPath)))
      .resolves.toMatchObject({ status: "installed" })
    const firstProfile = await readFile(test.profilePath, "utf8")
    await expect(test.installer.install(context(test.codexPath)))
      .resolves.toMatchObject({ status: "already-installed" })

    const config = await test.globalStore.load()
    expect(config).toMatchObject({
      realCodexExecutable: test.codexPath,
      realCodexVersion: "codex-cli 1.0.0",
      shellIntegration: { enabled: true, shells: [{ shell: "zsh", profilePath: test.profilePath }] },
    })
    const shimDirectory = config.shellIntegration.shimDirectory!
    expect(verifyShim(await readFile(path.join(shimDirectory, "codex"), "utf8"), {
      platform: "darwin",
      nodeExecutable: process.execPath,
      cliEntry: test.cliEntry,
      entry: "codex",
    })).toBe(true)
    expect(await readFile(test.profilePath, "utf8")).toBe(firstProfile)
    expect(await readFile(test.otherProfile, "utf8")).toBe(bashBefore)
    expect(test.output.join("\n")).toContain(test.codexPath)
    expect(test.output.join("\n")).toContain(test.profilePath)
    expect(test.output.join("\n")).toContain(test.globalStore.configPath)
    expect((await stat(path.join(shimDirectory, "codex"))).mode & 0o111).not.toBe(0)
  })

  it("非 TTY 或确认文本不匹配时零写入", async () => {
    const nonTty = await harness({ isTTY: false })
    const nonTtyProfile = await readFile(nonTty.profilePath, "utf8")
    await expect(nonTty.installer.install(context(nonTty.codexPath))).rejects.toThrow("TTY")
    expect((await nonTty.globalStore.load()).shellIntegration.enabled).toBe(false)
    expect(await readFile(nonTty.profilePath, "utf8")).toBe(nonTtyProfile)

    const cancelled = await harness({ confirmation: "yes" })
    await expect(cancelled.installer.install(context(cancelled.codexPath))).rejects.toThrow("已取消")
    expect((await cancelled.globalStore.load()).shellIntegration.enabled).toBe(false)
  })

  it("install、status 和 uninstall 均不修改 Codex config.toml", async () => {
    const test = await harness()
    const codexDirectory = path.join(test.home, ".codex")
    const codexConfig = path.join(codexDirectory, "config.toml")
    const original = "model = 'user-choice'\napproval_policy = 'on-request'\n"
    await mkdir(codexDirectory, { recursive: true })
    await writeFile(codexConfig, original, "utf8")

    await test.installer.install(context(test.codexPath))
    await test.installer.status()
    test.setConfirmation("UNINSTALL")
    await test.installer.uninstall()

    expect(await readFile(codexConfig, "utf8")).toBe(original)
  })

  it("未知 shim 冲突时拒绝且不覆盖", async () => {
    const test = await harness()
    const shimDirectory = path.join(test.globalStore.configDirectory, "shims")
    await mkdir(shimDirectory, { recursive: true })
    const shimPath = path.join(shimDirectory, "codex")
    await writeFile(shimPath, "user-owned", "utf8")

    await expect(test.installer.install(context(test.codexPath))).rejects.toThrow("冲突")

    expect(await readFile(shimPath, "utf8")).toBe("user-owned")
  })

  it.each(["cli", "shim"])("真实 Codex 指向 %s 自身时拒绝递归", async (target) => {
    const test = await harness()
    const recursivePath = target === "cli"
      ? test.cliEntry
      : path.join(test.globalStore.configDirectory, "shims", "codex")
    if (target === "shim") {
      await mkdir(path.dirname(recursivePath), { recursive: true })
      await writeFile(recursivePath, "fake", "utf8")
    }

    await expect(test.installer.install(context(recursivePath))).rejects.toThrow("递归")
    expect((await test.globalStore.load()).shellIntegration.enabled).toBe(false)
  })

  it("验证失败时反向恢复 profile、shim 和全局配置", async () => {
    const test = await harness({ verify: async () => { throw new Error("PATH 验证失败") } })
    const profileBefore = await readFile(test.profilePath, "utf8")

    await expect(test.installer.install(context(test.codexPath))).rejects.toThrow("PATH 验证失败")

    expect(await readFile(test.profilePath, "utf8")).toBe(profileBefore)
    expect((await test.globalStore.load()).shellIntegration.enabled).toBe(false)
    await expect(stat(test.globalStore.configPath)).rejects.toMatchObject({ code: "ENOENT" })
    const shimDirectory = path.join(test.globalStore.configDirectory, "shims")
    await expect(stat(path.join(shimDirectory, "codex"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("卸载只移除完整当前块，最后一个 shell 才删除 shim，并可重复", async () => {
    const test = await harness()
    const original = await readFile(test.profilePath, "utf8")
    await test.installer.install(context(test.codexPath))
    test.setConfirmation("UNINSTALL")

    await expect(test.installer.uninstall()).resolves.toMatchObject({ status: "uninstalled" })
    await expect(test.installer.uninstall()).resolves.toMatchObject({ status: "already-uninstalled" })

    expect(await readFile(test.profilePath, "utf8")).toBe(original)
    expect((await test.globalStore.load()).shellIntegration.enabled).toBe(false)
    await expect(stat(path.join(test.globalStore.configDirectory, "shims")))
      .rejects.toMatchObject({ code: "ENOENT" })
  })

  it("status 只读检查 profile、shim、保存身份和 PATH 顺序", async () => {
    const test = await harness()
    await test.installer.install(context(test.codexPath))

    await expect(test.installer.status()).resolves.toMatchObject({
      status: "already-installed",
      healthy: true,
      issues: [],
    })

    const shimPath = path.join(test.globalStore.configDirectory, "shims", "codex")
    await writeFile(shimPath, "modified", "utf8")
    await expect(test.installer.status()).resolves.toMatchObject({
      status: "already-installed",
      healthy: false,
      issues: expect.arrayContaining([expect.stringContaining("checksum")]),
    })
  })

  it("status 在 PATH 顺序错误或保存身份缺失时只读报告异常", async () => {
    const test = await harness({ currentPath: "/usr/bin:/bin" })
    await test.installer.install(context(test.codexPath))
    await test.globalStore.update((config) => {
      config.realCodexVersion = null
    })

    await expect(test.installer.status()).resolves.toMatchObject({
      healthy: false,
      issues: expect.arrayContaining([
        expect.stringContaining("路径或版本缺失"),
        expect.stringContaining("PATH"),
      ]),
    })
  })

  it("还有其他 shell 记录时仅卸载当前 zsh 并保留共享 shim", async () => {
    const test = await harness()
    await test.installer.install(context(test.codexPath))
    await test.globalStore.update((config) => {
      config.shellIntegration.shells.push({
        shell: "bash",
        profilePath: path.join(test.home, ".bashrc"),
      })
    })
    test.setConfirmation("UNINSTALL")

    await test.installer.uninstall()

    const config = await test.globalStore.load()
    expect(config.shellIntegration.enabled).toBe(true)
    expect(config.shellIntegration.shells).toEqual([{
      shell: "bash",
      profilePath: path.join(test.home, ".bashrc"),
    }])
    await expect(stat(path.join(config.shellIntegration.shimDirectory!, "codex")))
      .resolves.toBeDefined()
  })

  it("卸载遇到用户改写的 shim 时保留 profile 和文件并报告冲突", async () => {
    const test = await harness()
    await test.installer.install(context(test.codexPath))
    const profileBefore = await readFile(test.profilePath, "utf8")
    const shimPath = path.join(test.globalStore.configDirectory, "shims", "codex")
    await writeFile(shimPath, "user edit", "utf8")
    test.setConfirmation("UNINSTALL")

    await expect(test.installer.uninstall()).rejects.toThrow("拒绝删除")
    expect(await readFile(test.profilePath, "utf8")).toBe(profileBefore)
    expect(await readFile(shimPath, "utf8")).toBe("user edit")
  })

  it("Windows PowerShell 事务只写 .cmd shim 和当前 profile", async () => {
    const root = await temporaryRoot()
    const home = path.join(root, "home")
    const localAppData = path.join(root, "local app data")
    const profilePath = path.join(home, "profile.ps1")
    const codexPath = path.join(root, "codex.exe")
    const cliEntry = path.join(root, "guard cli.js")
    await mkdir(home, { recursive: true })
    await writeFile(profilePath, "$env:USER_SETTING = '1'", "utf8")
    await writeFile(codexPath, "fake", "utf8")
    await writeFile(cliEntry, "fake", "utf8")
    const globalStore = new GlobalConfigStore({
      platform: "win32",
      home,
      localAppData,
    })
    const shimDirectory = path.join(globalStore.configDirectory, "shims")
    const installer = new ShellInstaller({
      rootDirectory: root,
      globalStore,
      nodeExecutable: "C:\\Program Files\\node.exe",
      cliEntry,
      platform: "win32",
      home,
      detectShell: async () => ({ shell: "powershell", profilePath }),
      isTTY: true,
      confirm: async () => "INSTALL",
      writeOutput: () => undefined,
      verifyInstallation: async () => undefined,
      currentPath: `${shimDirectory};C:\\Windows`,
    })

    await installer.install(context(codexPath))

    expect(await readFile(path.join(shimDirectory, "codex.cmd"), "utf8"))
      .toContain("%*")
    expect(await readFile(profilePath, "utf8"))
      .toContain("$env:PATH = '")
    await expect(stat(path.join(shimDirectory, "codex")))
      .rejects.toMatchObject({ code: "ENOENT" })
  })

  it("缺少 remote 能力时在确认和写入前拒绝", async () => {
    const test = await harness()
    const incompatible = context(test.codexPath)
    incompatible.remoteCapabilities.remoteUnixSocket = false

    await expect(test.installer.install(incompatible)).rejects.toThrow("remoteUnixSocket")

    expect((await test.globalStore.load()).shellIntegration.enabled).toBe(false)
    expect(test.output).toEqual([])
  })
})
