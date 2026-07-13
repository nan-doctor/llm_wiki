import { describe, expect, it } from "vitest"
import { buildCapabilityMatrix, type ProtocolCapabilities } from "../src/doctor.js"
import { createInitialState } from "../src/guard/state-machine.js"
import { executeCli, type CliController, type CliDependencies } from "../src/cli-runtime.js"
import type { RuntimeContext } from "../src/runtime/runtime-context.js"
import type { ResolvedCodexExecutable } from "../src/runtime/types.js"
import {
  defaultGlobalGuardConfig,
  type GlobalGuardConfig,
} from "../src/persistence/global-config-store.js"

function setup() {
  const calls: string[] = []
  const errors: string[] = []
  const childCalls: Array<{ executable: string; args: string[] }> = []
  const state = createInitialState()
  const controller: CliController = {
    async start() { calls.push("start") },
    async stop() { calls.push("stop") },
    status() { return { state, admission: "ALLOWED" } },
    async run(_prompt, options) {
      calls.push(`run:goal=${String(options?.requireGoalControl ?? false)}`)
      return { threadId: "thread-1", turnId: "turn-1" }
    },
    async resume(_prompt, options) {
      calls.push(`resume:goal=${String(options?.requireGoalControl ?? false)}`)
      return { threadId: "thread-1", turnId: "turn-2" }
    },
    async waitForTurn() { calls.push("wait"); return "completed" },
    async waitForIdle() { calls.push("idle") },
    async refreshAndHandleQuota() { calls.push("refresh") },
  }
  const output: string[] = []
  const capabilities: ProtocolCapabilities = {
    rateLimitsRead: true,
    rateLimitsUpdated: true,
    turnStart: true,
    turnInterrupt: true,
    threadRead: true,
    goalGet: true,
    goalSet: true,
    goalPaused: true,
    goalResume: true,
    backgroundTerminalsClean: true,
    serverRequestHandling: true,
  }
  const runtimeContext: RuntimeContext = {
    executable: {
      codexExecutable: "/selected/codex",
      codexExecutableRealPath: "/real/selected/codex",
      codexVersion: "codex-cli 0.131.0",
      executableSelectionSource: "path",
      launchAllowed: true,
      discoveredCandidates: [],
    },
    protocolFingerprint: "fingerprint",
    schemaCapabilities: capabilities,
    capabilityMatrix: buildCapabilityMatrix(capabilities),
    remoteCapabilities: {
      remoteTui: true,
      remoteAuthTokenEnv: true,
      remoteUnixSocket: true,
      remoteLoopbackWebSocket: true,
      appServerStdio: true,
    },
  }
  const interactiveSession = {
    async run(options: { tuiArgs: string[]; requireProtection: boolean }) {
      calls.push(`interactive:run:${JSON.stringify(options)}`)
      return 7
    },
    async stop(reason: string) { calls.push(`interactive:stop:${reason}`) },
  }
  const shellInstaller = {
    async install(context: RuntimeContext) {
      expect(context).toBe(runtimeContext)
      calls.push("shell:install")
      return {
        status: "installed" as const,
        shell: "zsh" as const,
        profilePath: "/home/me/.zshrc",
        shimDirectory: "/home/me/.local/share/codex-quota-guard/shims",
      }
    },
    async status() {
      calls.push("shell:status")
      return { status: "already-installed" as const, shell: "zsh" as const }
    },
    async uninstall() {
      calls.push("shell:uninstall")
      return { status: "uninstalled" as const, shell: "zsh" as const }
    },
  }
  let globalConfig = defaultGlobalGuardConfig()
  let childExitCode = 0
  let shimIsTTY = true
  let unknownChoice = "cancel"
  let observedVersion = "codex-cli 0.131.0"
  const dependencies: CliDependencies = {
    rootDirectory: "/tmp/fake-root",
    resolveRuntimeContext: async (codexPath) => {
      calls.push(`resolve:${codexPath ?? "default"}`)
      return runtimeContext
    },
    shim: {
      environment: {},
      get isTTY() { return shimIsTTY },
      guardVersion: "0.3.0",
      cliEntryPath: "/guard/dist/src/cli.js",
      resolveSavedExecutable: async (codexPath): Promise<ResolvedCodexExecutable> => {
        calls.push(`saved-resolve:${codexPath}`)
        return {
          codexExecutable: codexPath,
          codexExecutableRealPath: codexPath,
          codexVersion: observedVersion,
          executableSelectionSource: "cli",
          launchAllowed: true,
          discoveredCandidates: [],
        }
      },
      runChild: async (executable, args) => {
        childCalls.push({ executable, args: [...args] })
        return childExitCode
      },
      promptUnknown: async () => unknownChoice,
      writeError: (value) => errors.push(value),
    },
    createController: (context) => {
      expect(context).toBe(runtimeContext)
      calls.push("controller")
      return controller
    },
    createInteractiveSession: (context) => {
      expect(context).toBe(runtimeContext)
      calls.push("interactive:create")
      return interactiveSession
    },
    createShellInstaller: () => shellInstaller,
    platform: "darwin",
    globalConfigStore: {
      load: async () => structuredClone(globalConfig),
      update: async (mutator) => {
        const next = structuredClone(globalConfig)
        mutator(next)
        globalConfig = next
        return structuredClone(globalConfig)
      },
    },
    loadProjectConfig: async () => ({ codexPath: "./project-codex" }),
    acquireLock: async () => ({ release: async () => { calls.push("release") } }),
    liveCanaryConsent: false,
    runDoctor: async (context, liveCanary = false) => {
      expect(context).toBe(runtimeContext)
      calls.push(`doctor:${String(liveCanary)}`)
      return ({
      ok: true,
      status: "ok",
      codexExecutable: "/selected/codex",
      executableRealPath: "/real/selected/codex",
      executableSelectionSource: "path",
      codexVersion: "codex-cli 0.131.0",
      protocolFingerprint: "fingerprint",
      appServerHandshake: true,
      rateLimitsRead: true,
      fiveHourProtectionAvailable: true,
      protocol: {
        versionStatus: "tested",
        compatibilityBasis: "generated-schema",
        requiredCapabilitiesPresent: true,
      },
      capabilities,
      capabilityMatrix: buildCapabilityMatrix(capabilities, { rateLimitsRead: true }),
      remoteCapabilities: runtimeContext.remoteCapabilities,
      liveCanary: null,
      warnings: [],
      errors: [],
      })
    },
    writeOutput: (value) => output.push(value),
  }
  return {
    calls,
    errors,
    childCalls,
    output,
    dependencies,
    controller,
    state,
    runtimeContext,
    interactiveSession,
    setGlobalConfig(value: GlobalGuardConfig) { globalConfig = structuredClone(value) },
    getGlobalConfig() { return structuredClone(globalConfig) },
    enableShell(options: { defaultProtection?: boolean; savedVersion?: string } = {}) {
      const config = defaultGlobalGuardConfig()
      config.defaultInteractiveProtection = options.defaultProtection ?? true
      config.realCodexExecutable = "/real/selected/codex"
      config.realCodexVersion = options.savedVersion ?? "codex-cli 0.100.0"
      config.shellIntegration = {
        enabled: true,
        shimDirectory: "/home/me/.local/share/codex-quota-guard/shims",
        installedAt: "2026-07-13T00:00:00.000Z",
        shells: [{ shell: "zsh", profilePath: "/home/me/.zshrc" }],
      }
      globalConfig = config
    },
    setChildExitCode(value: number) { childExitCode = value },
    setShimIsTTY(value: boolean) { shimIsTTY = value },
    setUnknownChoice(value: string) { unknownChoice = value },
    setObservedVersion(value: string) { observedVersion = value },
  }
}

describe("executeCli", () => {
  it("--help 不启动 App Server 或取得控制器锁", async () => {
    const test = setup()

    const code = await executeCli(["--help"], test.dependencies)

    expect(code).toBe(0)
    expect(test.calls).toEqual([])
    expect(test.output[0]).toContain("codex-quota-guard run <提示>")
    expect(test.output[0]).toContain("--require-protection")
    expect(test.output[0]).toContain("--codex-path <绝对路径>")
    expect(test.output[0]).toContain("codex-quota-guard interactive")
    expect(test.output[0]).toContain("任务提示请在 TUI 内输入")
    expect(test.output[0]).not.toContain("__shim")
  })

  it("interactive 只构造一次上下文、持锁并原样返回 TUI 退出码", async () => {
    const test = setup()
    test.dependencies.acquireLock = async () => {
      test.calls.push("acquire")
      return { release: async () => { test.calls.push("release") } }
    }

    const code = await executeCli([
      "interactive",
      "--require-protection",
      "--",
      "--model",
      "gpt-test",
    ], test.dependencies)

    expect(code).toBe(7)
    expect(test.calls).toEqual([
      "resolve:default",
      "acquire",
      "interactive:create",
      "interactive:run:{\"tuiArgs\":[\"--model\",\"gpt-test\"],\"requireProtection\":true}",
      "interactive:stop:cli-finally",
      "release",
    ])
    expect(test.calls.some((call) => call === "controller")).toBe(false)
  })

  it("interactive 异常仍停止 session 并释放锁", async () => {
    const test = setup()
    test.dependencies.createInteractiveSession = () => ({
      async run() { throw new Error("TUI 启动失败") },
      async stop(reason) { test.calls.push(`failed-session:stop:${reason}`) },
    })

    await expect(executeCli(["interactive"], test.dependencies))
      .rejects.toThrow("TUI 启动失败")

    expect(test.calls).toContain("failed-session:stop:cli-finally")
    expect(test.calls).toContain("release")
  })

  it("config show 合并全局和项目配置且不启动运行时", async () => {
    const test = setup()

    expect(await executeCli(["config", "show", "--json"], test.dependencies)).toBe(0)

    expect(test.calls).toEqual([])
    expect(JSON.parse(test.output[0])).toEqual({
      global: defaultGlobalGuardConfig(),
      project: {
        codexPath: "./project-codex",
        source: "project .codex-guard/config.json",
      },
    })
  })

  it("config set 只更新默认严格保护且不取得锁", async () => {
    const test = setup()

    expect(await executeCli([
      "config",
      "set",
      "default-require-protection",
      "true",
    ], test.dependencies)).toBe(0)
    expect(test.calls).toEqual([])
    expect(test.output.at(-1)).toContain("defaultRequireProtection=true")

    const interactive = await executeCli(["interactive"], test.dependencies)
    expect(interactive).toBe(7)
    expect(test.calls).toContain(
      "interactive:run:{\"tuiArgs\":[],\"requireProtection\":true}",
    )
  })

  it("显式严格 flag 在全局默认 false 时仍传给 interactive", async () => {
    const test = setup()
    const config = defaultGlobalGuardConfig()
    config.defaultRequireProtection = false
    test.setGlobalConfig(config)

    await executeCli(["interactive", "--require-protection"], test.dependencies)

    expect(test.calls).toContain(
      "interactive:run:{\"tuiArgs\":[],\"requireProtection\":true}",
    )
  })

  it("shell install 才解析运行上下文并输出结果", async () => {
    const test = setup()

    expect(await executeCli([
      "shell",
      "install",
      "--codex-path",
      "/real/codex",
    ], test.dependencies)).toBe(0)

    expect(test.calls).toEqual(["resolve:/real/codex", "shell:install"])
    expect(test.output.at(-1)).toContain("installed")
  })

  it("重复 shell install 不从已接管的 PATH 选 shim，而复用保存的真实路径", async () => {
    const test = setup()
    test.enableShell()

    expect(await executeCli(["shell", "install"], test.dependencies)).toBe(0)

    expect(test.calls).toEqual(["resolve:/real/selected/codex", "shell:install"])
  })

  it("shell status 和 uninstall 不解析运行上下文或取得任务锁", async () => {
    const status = setup()
    expect(await executeCli(["shell", "status", "--json"], status.dependencies)).toBe(0)
    expect(status.calls).toEqual(["shell:status"])
    expect(JSON.parse(status.output.at(-1)!)).toMatchObject({
      status: "already-installed",
      shell: "zsh",
    })

    const uninstall = setup()
    expect(await executeCli(["shell", "uninstall"], uninstall.dependencies)).toBe(0)
    expect(uninstall.calls).toEqual(["shell:uninstall"])
    expect(uninstall.output.at(-1)).toContain("uninstalled")
  })

  it("隐藏 identity 只返回已验证的保存绝对路径", async () => {
    const test = setup()
    test.enableShell()

    expect(await executeCli(["__shim", "identity"], test.dependencies)).toBe(0)

    expect(test.calls).toEqual(["saved-resolve:/real/selected/codex"])
    expect(test.output).toEqual(["/real/selected/codex"])
    expect(test.childCalls).toEqual([])
  })

  it("codex-raw 和单次 BYPASS 原样执行保存路径并保留退出码", async () => {
    const raw = setup()
    raw.enableShell()
    raw.setChildExitCode(37)

    expect(await executeCli([
      "__shim",
      "codex-raw",
      "exec",
      "path with spaces",
    ], raw.dependencies)).toBe(37)
    expect(raw.childCalls).toEqual([{
      executable: "/real/selected/codex",
      args: ["exec", "path with spaces"],
    }])
    expect(raw.errors.join("\n")).toContain("未受额度保护")

    const bypass = setup()
    bypass.enableShell()
    bypass.dependencies.shim.environment.CODEX_QUOTA_GUARD_BYPASS = "1"
    expect(await executeCli([
      "__shim",
      "codex",
      "login",
    ], bypass.dependencies)).toBe(0)
    expect(bypass.childCalls[0]).toEqual({
      executable: "/real/selected/codex",
      args: ["login"],
    })
  })

  it("非 TTY raw 不污染公开输出或错误输出", async () => {
    const test = setup()
    test.enableShell()
    test.setShimIsTTY(false)

    expect(await executeCli(["__shim", "codex-raw", "--version"], test.dependencies)).toBe(0)
    expect(test.output).toEqual([])
    expect(test.errors).toEqual([])
  })

  it("管理命令只说明一次并直接执行真实 Codex", async () => {
    const test = setup()
    test.enableShell()

    expect(await executeCli(["__shim", "codex", "mcp", "list"], test.dependencies)).toBe(0)

    expect(test.errors).toHaveLength(1)
    expect(test.errors[0]).toContain("原生管理命令")
    expect(test.childCalls[0]).toEqual({
      executable: "/real/selected/codex",
      args: ["mcp", "list"],
    })
  })

  it("codex exec 明确拒绝并给出两条安全替代路径", async () => {
    const test = setup()
    test.enableShell()

    expect(await executeCli(["__shim", "codex", "exec", "x"], test.dependencies)).toBe(2)

    expect(test.errors.join("\n")).toContain("codex-quota-guard run")
    expect(test.errors.join("\n")).toContain("codex-raw exec")
    expect(test.childCalls).toEqual([])
  })

  it("未知命令非 TTY 拒绝，TTY 仅明确输入 raw 才旁路", async () => {
    const nonTty = setup()
    nonTty.enableShell()
    nonTty.setShimIsTTY(false)
    expect(await executeCli([
      "__shim",
      "codex",
      "future-command",
    ], nonTty.dependencies)).toBe(2)
    expect(nonTty.childCalls).toEqual([])

    const tty = setup()
    tty.enableShell()
    tty.setUnknownChoice("raw")
    expect(await executeCli([
      "__shim",
      "codex",
      "future-command",
    ], tty.dependencies)).toBe(0)
    expect(tty.childCalls[0].args).toEqual(["future-command"])

    const cancel = setup()
    cancel.enableShell()
    cancel.setUnknownChoice("")
    expect(await executeCli([
      "__shim",
      "codex",
      "future-command",
    ], cancel.dependencies)).toBe(2)
    expect(cancel.childCalls).toEqual([])
  })

  it("wrapper version 同时显示工具、保存路径、保存和实测版本", async () => {
    const test = setup()
    test.enableShell({ savedVersion: "codex-cli old" })
    test.setObservedVersion("codex-cli new")

    expect(await executeCli(["__shim", "codex", "--version"], test.dependencies)).toBe(0)

    expect(test.output[0]).toContain("0.3.0")
    expect(test.output[0]).toContain("/real/selected/codex")
    expect(test.output[0]).toContain("codex-cli old")
    expect(test.output[0]).toContain("codex-cli new")
  })

  it("guarded interactive 重新探测当前保存路径，成功后才更新版本", async () => {
    const test = setup()
    test.enableShell({ savedVersion: "codex-cli old" })
    test.runtimeContext.executable.codexVersion = "codex-cli new"

    expect(await executeCli([
      "__shim",
      "codex",
      "--model",
      "gpt-test",
    ], test.dependencies)).toBe(7)

    expect(test.calls).toContain("resolve:/real/selected/codex")
    expect(test.calls).toContain(
      "interactive:run:{\"tuiArgs\":[\"--model\",\"gpt-test\"],\"requireProtection\":false}",
    )
    expect(test.getGlobalConfig().realCodexVersion).toBe("codex-cli new")
  })

  it("guarded interactive 缺少 remote 能力时拒绝并保留旧版本", async () => {
    const test = setup()
    test.enableShell({ savedVersion: "codex-cli old" })
    test.runtimeContext.executable.codexVersion = "codex-cli new"
    test.runtimeContext.remoteCapabilities.remoteUnixSocket = false

    await expect(executeCli(["__shim", "codex"], test.dependencies))
      .rejects.toThrow("remoteUnixSocket")

    expect(test.getGlobalConfig().realCodexVersion).toBe("codex-cli old")
    expect(test.calls).not.toContain("interactive:create")
  })

  it("关闭默认交互保护时明确拒绝而不静默 raw", async () => {
    const test = setup()
    test.enableShell({ defaultProtection: false })

    expect(await executeCli(["__shim", "codex"], test.dependencies)).toBe(2)

    expect(test.errors.join("\n")).toContain("codex-raw")
    expect(test.childCalls).toEqual([])
    expect(test.calls).not.toContain("interactive:create")
  })

  it.each([
    "/guard/dist/src/cli.js",
    "/home/me/.local/share/codex-quota-guard/shims/codex",
  ])("保存路径指向 Guard 自身时在执行 resolver 前拒绝递归：%s", async (savedPath) => {
    const test = setup()
    test.enableShell()
    const config = test.getGlobalConfig()
    config.realCodexExecutable = savedPath
    test.setGlobalConfig(config)

    await expect(executeCli(["__shim", "codex-raw", "--version"], test.dependencies))
      .rejects.toThrow("拒绝递归")

    expect(test.calls).toEqual([])
    expect(test.childCalls).toEqual([])
  })

  it("保存路径不可执行时提示 doctor 且不查询 PATH", async () => {
    const test = setup()
    test.enableShell()
    test.dependencies.shim.resolveSavedExecutable = async (codexPath) => {
      test.calls.push(`saved-failed:${codexPath}`)
      throw new Error("EACCES")
    }

    await expect(executeCli(["__shim", "codex-raw", "login"], test.dependencies))
      .rejects.toThrow("codex-quota-guard doctor")

    expect(test.calls).toEqual(["saved-failed:/real/selected/codex"])
    expect(test.childCalls).toEqual([])
  })

  it.each([
    ["darwin", "remoteUnixSocket"],
    ["linux", "remoteUnixSocket"],
    ["win32", "remoteLoopbackWebSocket"],
    ["darwin", "remoteTui"],
    ["darwin", "remoteAuthTokenEnv"],
    ["darwin", "appServerStdio"],
  ] as const)("%s 缺少 %s 时在创建 session 前安全拒绝", async (platform, key) => {
    const test = setup()
    test.dependencies.platform = platform
    test.runtimeContext.remoteCapabilities[key] = false

    await expect(executeCli(["interactive"], test.dependencies))
      .rejects.toThrow(key)
    await expect(executeCli(["interactive"], test.dependencies))
      .rejects.toThrow("codex-guarded")
    expect(test.calls).not.toContain("interactive:create")
  })

  it("live canary 缺少确认变量时在启动 App Server 前拒绝", async () => {
    const test = setup()

    await expect(executeCli(["doctor", "--live-canary"], test.dependencies))
      .rejects.toThrow("CODEX_QUOTA_GUARD_LIVE_CANARY=I_ACCEPT_MODEL_USAGE")
    expect(test.calls).toEqual([])
  })

  it("live canary 双重确认后只把显式模式传给 doctor", async () => {
    const test = setup()
    test.dependencies.liveCanaryConsent = true

    const code = await executeCli(["doctor", "--live-canary", "--json"], test.dependencies)

    expect(code).toBe(0)
    expect(test.calls).toEqual(["resolve:default", "doctor:true"])
  })

  it("status 启动控制器但不调用 turn/start", async () => {
    const test = setup()

    const code = await executeCli(["status", "--json"], test.dependencies)

    expect(code).toBe(0)
    expect(test.calls).toEqual(["resolve:default", "controller", "start", "stop", "release"])
    expect(JSON.parse(test.output[0]).schemaVersion).toBe(1)
    expect(JSON.parse(test.output[0])).toMatchObject({
      executable: {
        codexExecutable: "/selected/codex",
        codexExecutableRealPath: "/real/selected/codex",
        codexVersion: "codex-cli 0.131.0",
        executableSelectionSource: "path",
      },
      protocolFingerprint: "fingerprint",
      capabilities: expect.any(Object),
      goalControl: "unavailable",
      runtimeChanges: [],
    })
  })

  it("控制器锁失败也包含运行环境影响诊断", async () => {
    const test = setup()
    test.dependencies.acquireLock = async () => {
      throw new Error("已有控制器")
    }

    const failure = executeCli(["status"], test.dependencies)
    await expect(failure).rejects.toThrow("当前 Codex：/real/selected/codex")
    await expect(failure).rejects.toThrow("原因：已有控制器")
    await expect(failure).rejects.toThrow("--codex-path <绝对路径>")
  })

  it("run 只启动一个 turn 并等待完成", async () => {
    const test = setup()

    const code = await executeCli(["run", "执行任务", "--json"], test.dependencies)

    expect(code).toBe(0)
    expect(test.calls.filter((call) => call.startsWith("run:"))).toHaveLength(1)
    expect(test.calls).toContain("wait")
  })

  it("turn 失败时命令返回错误而不是以退出码 0 伪装成功", async () => {
    const test = setup()
    test.state.errors.push("turn 失败：交互式审批请求不受支持")
    test.controller.waitForTurn = async () => "failed"

    const failure = executeCli(["run", "执行失败任务"], test.dependencies)
    await expect(failure).rejects.toThrow("turn 执行失败：交互式审批请求不受支持")
    await expect(failure).rejects.toThrow("当前 Codex：/real/selected/codex")
    await expect(failure).rejects.toThrow("额度读取影响：")
    await expect(failure).rejects.toThrow("精确 turn interrupt 影响：")
    await expect(failure).rejects.toThrow("Goal 控制影响：")
    await expect(failure).rejects.toThrow("--codex-path <绝对路径>")
    expect(test.calls).toContain("stop")
    expect(test.calls).toContain("release")
  })

  it("doctor 不创建任务控制器且不调用 turn/start", async () => {
    const test = setup()

    const code = await executeCli(["doctor", "--json"], test.dependencies)

    expect(code).toBe(0)
    expect(test.calls).toEqual(["resolve:default", "doctor:false"])
    expect(JSON.parse(test.output[0]).codexVersion).toBe("codex-cli 0.131.0")
    expect(JSON.parse(test.output[0])).toMatchObject({
      codexExecutable: "/selected/codex",
      executableRealPath: "/real/selected/codex",
      executableSelectionSource: "path",
      protocolFingerprint: "fingerprint",
    })
  })

  it("doctor 异常包含所选 Codex 与三类影响诊断", async () => {
    const test = setup()
    test.dependencies.runDoctor = async () => {
      throw new Error("handshake authorization=Basic secret-doctor")
    }

    const failure = executeCli(["doctor"], test.dependencies)
    await expect(failure).rejects.toThrow("当前 Codex：/real/selected/codex")
    await expect(failure).rejects.toThrow("额度读取影响：")
    await expect(failure).rejects.toThrow("精确 turn interrupt 影响：")
    await expect(failure).rejects.toThrow("Goal 控制影响：")
    await expect(failure).rejects.not.toThrow("secret-doctor")
  })

  it("doctor 文本逐项显示协议能力矩阵", async () => {
    const test = setup()

    const code = await executeCli(["doctor"], test.dependencies)

    expect(code).toBe(0)
    expect(test.output[0]).toContain("Codex version: codex-cli 0.131.0 (TESTED)")
    expect(test.output[0]).toContain("Codex executable: /selected/codex")
    expect(test.output[0]).toContain("Executable real path: /real/selected/codex")
    expect(test.output[0]).toContain("Selection source: path")
    expect(test.output[0]).toContain("Protocol fingerprint: fingerprint")
    expect(test.output[0]).toContain("Turn interrupt: schemaDetected")
    expect(test.output[0]).toContain("Thread read: schemaDetected")
    expect(test.output[0]).toContain("Goal resume: schemaDetected")
    expect(test.output[0]).toContain("Server request handling: schemaDetected")
    expect(test.output[0]).toContain("turn/interrupt: schema=DETECTED · runtime=NOT_TESTED")
    expect(test.output[0]).toContain("Goal paused: schema=DETECTED · runtime=NOT_TESTED")
    expect(test.output[0]).toContain("background terminal clean: schema=DETECTED · runtime=NOT_TESTED")
    expect(test.output[0]).toContain("account/rateLimits/read: schema=DETECTED · runtime=VERIFIED")
    expect(test.output[0]).toContain("compatibility basis: generated-schema")
    expect(test.output[0]).toContain("remote TUI: AVAILABLE")
    expect(test.output[0]).toContain("remote Unix socket: AVAILABLE")
  })

  it.each([
    ["status"],
    ["doctor"],
    ["run", "执行任务"],
    ["resume", "继续"],
  ])("%s 把 --codex-path 传给同一个 resolver", async (...command) => {
    const test = setup()

    await executeCli([...command, "--codex-path", "/路径 含空格/codex"], test.dependencies)

    expect(test.calls.filter((call) => call.startsWith("resolve:"))).toEqual([
      "resolve:/路径 含空格/codex",
    ])
  })

  it("把严格 Goal 参数传给 run 和 resume", async () => {
    const run = setup()
    await executeCli(["run", "执行", "--require-goal-control"], run.dependencies)
    expect(run.calls).toContain("run:goal=true")

    const resume = setup()
    await executeCli(["resume", "继续", "--require-goal-control"], resume.dependencies)
    expect(resume.calls).toContain("resume:goal=true")
  })
})
