import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  CodexExecutableError,
  resolveCodexExecutable,
  type ResolveCodexInput,
  type ResolverDependencies,
} from "../src/runtime/executable-resolver.js"

interface VirtualFile {
  file?: boolean
  executable?: boolean
  realPath?: string
  version?: string
  versionFails?: boolean
  appServerHelpFails?: boolean
}

function fakeDependencies(options: {
  platform?: NodeJS.Platform
  pathValue?: string
  pathExt?: string
  files?: Record<string, VirtualFile>
  candidates?: string[]
} = {}): ResolverDependencies & { executions: Array<{ executable: string; args: string[] }> } {
  const files = options.files ?? {}
  const executions: Array<{ executable: string; args: string[] }> = []
  return {
    platform: options.platform ?? "linux",
    pathValue: options.pathValue ?? "",
    pathExt: options.pathExt ?? ".EXE;.CMD;.BAT;.COM",
    executions,
    async stat(file) {
      const value = files[file]
      if (!value) throw nodeError("ENOENT")
      return { isFile: () => value.file ?? true }
    },
    async accessExecutable(file) {
      const value = files[file]
      if (!value) throw nodeError("ENOENT")
      if (value.executable === false) throw nodeError("EACCES")
    },
    async realpath(file) {
      const value = files[file]
      if (!value) throw nodeError("ENOENT")
      return value.realPath ?? file
    },
    async run(executable, args) {
      executions.push({ executable, args: [...args] })
      const value = files[executable]
      if (!value) throw nodeError("ENOENT")
      if (args[0] === "--version") {
        if (value.versionFails) throw new Error("version failed")
        return { stdout: `${value.version ?? "codex-cli 1.0.0"}\n`, stderr: "" }
      }
      if (value.appServerHelpFails) throw new Error("app-server unavailable")
      return { stdout: "Usage: codex app-server", stderr: "" }
    },
    async discoverCandidates() {
      return options.candidates ?? []
    },
  }
}

function nodeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

async function resolve(
  input: Partial<ResolveCodexInput>,
  dependencies: ResolverDependencies,
) {
  return await resolveCodexExecutable({ rootDirectory: "/repo", ...input }, dependencies)
}

describe("resolveCodexExecutable", () => {
  it("CLI 优先于环境、配置和 PATH，并支持空格路径", async () => {
    const cli = "/cli path/codex"
    const dependencies = fakeDependencies({
      pathValue: "/path/bin",
      files: {
        [cli]: { realPath: "/real cli/codex", version: "codex-cli 0.144.0" },
        "/env/codex": {},
        "/config/codex": {},
        "/path/bin/codex": {},
      },
    })

    const result = await resolve({
      cliPath: cli,
      environmentPath: "/env/codex",
      configPath: "/config/codex",
    }, dependencies)

    expect(result).toEqual({
      codexExecutable: cli,
      codexExecutableRealPath: "/real cli/codex",
      codexVersion: "codex-cli 0.144.0",
      executableSelectionSource: "cli",
      launchAllowed: true,
      discoveredCandidates: [],
    })
    expect(dependencies.executions).toEqual([
      { executable: cli, args: ["--version"] },
      { executable: cli, args: ["app-server", "--help"] },
    ])
  })

  it("环境优先于配置和 PATH", async () => {
    const dependencies = fakeDependencies({
      pathValue: "/path/bin",
      files: {
        "/env/codex": {},
        "/config/codex": {},
        "/path/bin/codex": {},
      },
    })

    expect(await resolve({
      environmentPath: "/env/codex",
      configPath: "/config/codex",
    }, dependencies)).toMatchObject({
      codexExecutable: "/env/codex",
      executableSelectionSource: "environment",
    })
  })

  it("配置优先于 PATH，且相对配置路径以项目根目录解析", async () => {
    const configured = path.posix.resolve("/repo", "tools/codex")
    const dependencies = fakeDependencies({
      pathValue: "/path/bin",
      files: {
        [configured]: {},
        "/path/bin/codex": {},
      },
    })

    expect(await resolve({ configPath: "tools/codex" }, dependencies)).toMatchObject({
      codexExecutable: configured,
      executableSelectionSource: "config",
    })
  })

  it("Linux 和 macOS 使用 PATH 中的绝对可执行文件", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const dependencies = fakeDependencies({
        platform,
        pathValue: "/missing:/chosen",
        files: { "/chosen/codex": {} },
      })

      expect(await resolve({}, dependencies)).toMatchObject({
        codexExecutable: "/chosen/codex",
        executableSelectionSource: "path",
      })
    }
  })

  it("Windows 使用 PATH 和 PATHEXT 解析 codex.EXE", async () => {
    const executable = "C:\\chosen\\codex.EXE"
    const dependencies = fakeDependencies({
      platform: "win32",
      pathValue: "C:\\missing;C:\\chosen",
      pathExt: ".EXE;.CMD",
      files: { [executable]: {} },
    })

    expect(await resolve({ rootDirectory: "C:\\repo" }, dependencies)).toMatchObject({
      codexExecutable: executable,
      executableSelectionSource: "path",
    })
  })

  it("PATH 缺失时只报告发现的候选，不执行候选", async () => {
    const candidate = "/Applications/ChatGPT.app/Contents/Resources/codex"
    const dependencies = fakeDependencies({
      platform: "darwin",
      candidates: [candidate],
      files: { [candidate]: {} },
    })

    expect(await resolve({}, dependencies)).toEqual({
      codexExecutable: candidate,
      codexExecutableRealPath: null,
      codexVersion: null,
      executableSelectionSource: "discoveredCandidate",
      launchAllowed: false,
      discoveredCandidates: [candidate],
    })
    expect(dependencies.executions).toEqual([])
  })

  it.each([
    ["路径不存在", "/broken/missing", null, "stat"],
    ["不是普通文件", "/broken/directory", { file: false }, "stat"],
    ["文件不可执行", "/broken/no-exec", { executable: false }, "executable"],
    ["--version 失败", "/broken/version", { versionFails: true }, "version"],
    ["app-server 不可用", "/broken/app-server", { appServerHelpFails: true }, "app-server-help"],
  ] as const)("%s 时不静默回退到 PATH", async (_name, cliPath, broken, stage) => {
    const dependencies = fakeDependencies({
      pathValue: "/valid",
      files: {
        ...(broken === null ? {} : { [cliPath]: broken }),
        "/valid/codex": {},
      },
    })

    await expect(resolve({ cliPath }, dependencies)).rejects.toMatchObject({
      source: "cli",
      stage,
      executable: cliPath,
    })
    expect(dependencies.executions.every((entry) => entry.executable === cliPath)).toBe(true)
  })

  it("没有 PATH 或候选时返回可诊断选择错误", async () => {
    const dependencies = fakeDependencies()

    await expect(resolve({}, dependencies)).rejects.toBeInstanceOf(CodexExecutableError)
    await expect(resolve({}, dependencies)).rejects.toMatchObject({
      source: null,
      stage: "selection",
      executable: null,
    })
  })
})
