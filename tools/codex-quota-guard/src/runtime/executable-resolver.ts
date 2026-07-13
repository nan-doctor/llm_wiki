import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import path from "node:path"
import type {
  ExecutableSelectionSource,
  ExecutableValidationStage,
  ResolvedCodexExecutable,
} from "./types.js"
import { sanitizeDiagnostic } from "../persistence/state-store.js"

export interface ResolveCodexInput {
  rootDirectory: string
  cliPath?: string
  environmentPath?: string
  configPath?: string
}

export interface ResolverDependencies {
  platform: NodeJS.Platform
  pathValue: string
  pathExt: string
  stat(file: string): Promise<{ isFile(): boolean }>
  accessExecutable(file: string): Promise<void>
  realpath(file: string): Promise<string>
  run(executable: string, args: string[]): Promise<{ stdout: string; stderr: string }>
  discoverCandidates(): Promise<string[]>
}

export class CodexExecutableError extends Error {
  constructor(
    message: string,
    readonly executable: string | null,
    readonly source: ExecutableSelectionSource | null,
    readonly stage: ExecutableValidationStage,
  ) {
    super(message)
    this.name = "CodexExecutableError"
  }
}

export async function resolveCodexExecutable(
  input: ResolveCodexInput,
  dependencies: ResolverDependencies = defaultResolverDependencies(),
): Promise<ResolvedCodexExecutable> {
  const platformPath = dependencies.platform === "win32" ? path.win32 : path.posix
  const configured = firstConfiguredSource(input)
  let selected: { value: string; source: ExecutableSelectionSource } | null = null

  if (configured) {
    selected = {
      value: platformPath.resolve(input.rootDirectory, configured.value),
      source: configured.source,
    }
  } else {
    const fromPath = await findOnPath(dependencies, platformPath)
    if (fromPath) selected = { value: fromPath, source: "path" }
  }

  if (!selected) {
    const discoveredCandidates = uniqueAbsoluteCandidates(
      await dependencies.discoverCandidates(),
      input.rootDirectory,
      platformPath,
    )
    const candidate = discoveredCandidates[0]
    if (candidate) {
      return {
        codexExecutable: candidate,
        codexExecutableRealPath: null,
        codexVersion: null,
        executableSelectionSource: "discoveredCandidate",
        launchAllowed: false,
        discoveredCandidates,
      }
    }
    throw new CodexExecutableError(
      diagnosticMessage(null, "没有从 CLI、环境、项目配置或 PATH 找到 Codex"),
      null,
      null,
      "selection",
    )
  }

  return await validateSelectedExecutable(selected.value, selected.source, dependencies)
}

function firstConfiguredSource(input: ResolveCodexInput): {
  value: string
  source: ExecutableSelectionSource
} | null {
  if (hasValue(input.cliPath)) return { value: input.cliPath, source: "cli" }
  if (hasValue(input.environmentPath)) {
    return { value: input.environmentPath, source: "environment" }
  }
  if (hasValue(input.configPath)) return { value: input.configPath, source: "config" }
  return null
}

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== ""
}

async function validateSelectedExecutable(
  executable: string,
  source: ExecutableSelectionSource,
  dependencies: ResolverDependencies,
): Promise<ResolvedCodexExecutable> {
  let file: { isFile(): boolean }
  try {
    file = await dependencies.stat(executable)
  } catch (error) {
    throw validationError(executable, source, "stat", "路径不存在或无法读取", error)
  }
  if (!file.isFile()) {
    throw validationError(executable, source, "stat", "路径不是普通文件")
  }

  if (dependencies.platform !== "win32") {
    try {
      await dependencies.accessExecutable(executable)
    } catch (error) {
      throw validationError(executable, source, "executable", "文件没有执行权限", error)
    }
  }

  let codexExecutableRealPath: string
  try {
    codexExecutableRealPath = await dependencies.realpath(executable)
  } catch (error) {
    throw validationError(executable, source, "stat", "无法解析真实路径", error)
  }

  let versionOutput: { stdout: string; stderr: string }
  try {
    versionOutput = await dependencies.run(executable, ["--version"])
  } catch (error) {
    throw validationError(executable, source, "version", "执行 --version 失败", error)
  }
  const codexVersion = versionOutput.stdout.trim()
  if (codexVersion === "") {
    throw validationError(executable, source, "version", "--version 没有返回版本")
  }

  try {
    await dependencies.run(executable, ["app-server", "--help"])
  } catch (error) {
    throw validationError(
      executable,
      source,
      "app-server-help",
      "执行 app-server --help 失败",
      error,
    )
  }

  return {
    codexExecutable: executable,
    codexExecutableRealPath,
    codexVersion,
    executableSelectionSource: source,
    launchAllowed: true,
    discoveredCandidates: [],
  }
}

async function findOnPath(
  dependencies: ResolverDependencies,
  platformPath: typeof path.posix | typeof path.win32,
): Promise<string | null> {
  const delimiter = dependencies.platform === "win32" ? ";" : ":"
  const directories = dependencies.pathValue.split(delimiter).filter((value) => value !== "")
  const names = dependencies.platform === "win32"
    ? dependencies.pathExt.split(";").filter(Boolean).map((extension) => `codex${extension}`)
    : ["codex"]

  for (const directory of directories) {
    for (const name of names) {
      const candidate = platformPath.resolve(directory, name)
      try {
        if ((await dependencies.stat(candidate)).isFile()) return candidate
      } catch {
        // PATH 中不存在的候选继续搜索。
      }
    }
  }
  return null
}

function uniqueAbsoluteCandidates(
  candidates: string[],
  rootDirectory: string,
  platformPath: typeof path.posix | typeof path.win32,
): string[] {
  return [...new Set(candidates
    .filter((candidate) => candidate.trim() !== "")
    .map((candidate) => platformPath.resolve(rootDirectory, candidate)))]
}

function validationError(
  executable: string,
  source: ExecutableSelectionSource,
  stage: ExecutableValidationStage,
  reason: string,
  cause?: unknown,
): CodexExecutableError {
  const detail = cause instanceof Error && cause.message
    ? `：${sanitizeDiagnostic(cause.message)}`
    : ""
  return new CodexExecutableError(
    diagnosticMessage(executable, `${reason}${detail}`),
    executable,
    source,
    stage,
  )
}

function diagnosticMessage(executable: string | null, reason: string): string {
  return [
    `Codex 可执行文件不可用：${executable ?? "未选择"}`,
    `原因：${reason}`,
    "影响：额度读取不可用；精确 turn interrupt 不可用；Goal 控制不可用",
    "修正：使用 --codex-path <绝对路径> 明确选择可用的 Codex",
  ].join("；")
}

function defaultResolverDependencies(): ResolverDependencies {
  const platform = process.platform
  return {
    platform,
    pathValue: process.env.PATH ?? "",
    pathExt: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    stat: async (file) => await stat(file),
    accessExecutable: async (file) => await access(file, constants.X_OK),
    realpath: async (file) => await realpath(file),
    run: runCommand,
    discoverCandidates: async () => await discoverPlatformCandidates(platform),
  }
}

async function discoverPlatformCandidates(platform: NodeJS.Platform): Promise<string[]> {
  if (platform !== "darwin") return []
  const candidate = "/Applications/ChatGPT.app/Contents/Resources/codex"
  try {
    if ((await stat(candidate)).isFile()) return [candidate]
  } catch {
    return []
  }
  return []
}

function runCommand(
  executable: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: "utf8",
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  })
}
