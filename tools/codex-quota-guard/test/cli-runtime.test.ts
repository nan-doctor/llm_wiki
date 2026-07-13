import { describe, expect, it } from "vitest"
import { createInitialState } from "../src/guard/state-machine.js"
import { executeCli, type CliController, type CliDependencies } from "../src/cli-runtime.js"

function setup() {
  const calls: string[] = []
  const state = createInitialState()
  const controller: CliController = {
    async start() { calls.push("start") },
    async stop() { calls.push("stop") },
    status() { return { state, admission: "ALLOWED" } },
    async run() { calls.push("run"); return { threadId: "thread-1", turnId: "turn-1" } },
    async resume() { calls.push("resume"); return { threadId: "thread-1", turnId: "turn-2" } },
    async waitForTurn() { calls.push("wait"); return "completed" },
    async waitForIdle() { calls.push("idle") },
    async refreshAndHandleQuota() { calls.push("refresh") },
  }
  const output: string[] = []
  const dependencies: CliDependencies = {
    rootDirectory: "/tmp/fake-root",
    createController: () => controller,
    acquireLock: async () => ({ release: async () => { calls.push("release") } }),
    liveCanaryConsent: false,
    runDoctor: async (liveCanary = false) => {
      calls.push(`doctor:${String(liveCanary)}`)
      return ({
      ok: true,
      status: "ok",
      codexVersion: "codex-cli 0.131.0",
      appServerHandshake: true,
      rateLimitsRead: true,
      fiveHourProtectionAvailable: true,
      protocol: {
        versionStatus: "tested",
        compatibilityBasis: "generated-schema",
        requiredCapabilitiesPresent: true,
      },
      capabilities: {
        rateLimitsRead: true,
        rateLimitsUpdated: true,
        turnStart: true,
        turnInterrupt: true,
        goalGet: true,
        goalSet: true,
        goalPaused: true,
        backgroundTerminalsClean: true,
      },
      capabilityMatrix: {
        rateLimitsRead: { schemaDetected: true, runtimeVerified: true },
        rateLimitsUpdated: { schemaDetected: true, runtimeVerified: null },
        turnStart: { schemaDetected: true, runtimeVerified: null },
        turnInterrupt: { schemaDetected: true, runtimeVerified: null },
        goalGet: { schemaDetected: true, runtimeVerified: null },
        goalSet: { schemaDetected: true, runtimeVerified: null },
        goalPaused: { schemaDetected: true, runtimeVerified: null },
        backgroundTerminalsClean: { schemaDetected: true, runtimeVerified: null },
      },
      liveCanary: null,
      warnings: [],
      errors: [],
      })
    },
    writeOutput: (value) => output.push(value),
  }
  return { calls, output, dependencies, controller, state }
}

describe("executeCli", () => {
  it("--help 不启动 App Server 或取得控制器锁", async () => {
    const test = setup()

    const code = await executeCli(["--help"], test.dependencies)

    expect(code).toBe(0)
    expect(test.calls).toEqual([])
    expect(test.output[0]).toContain("codex-quota-guard run <提示>")
    expect(test.output[0]).toContain("--require-protection")
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
    expect(test.calls).toEqual(["doctor:true"])
  })

  it("status 启动控制器但不调用 turn/start", async () => {
    const test = setup()

    const code = await executeCli(["status", "--json"], test.dependencies)

    expect(code).toBe(0)
    expect(test.calls).toEqual(["start", "stop", "release"])
    expect(JSON.parse(test.output[0]).schemaVersion).toBe(1)
  })

  it("run 只启动一个 turn 并等待完成", async () => {
    const test = setup()

    const code = await executeCli(["run", "执行任务", "--json"], test.dependencies)

    expect(code).toBe(0)
    expect(test.calls.filter((call) => call === "run")).toHaveLength(1)
    expect(test.calls).toContain("wait")
  })

  it("turn 失败时命令返回错误而不是以退出码 0 伪装成功", async () => {
    const test = setup()
    test.state.errors.push("turn 失败：交互式审批请求不受支持")
    test.controller.waitForTurn = async () => "failed"

    await expect(executeCli(["run", "执行失败任务"], test.dependencies))
      .rejects.toThrow("turn 执行失败：交互式审批请求不受支持")
    expect(test.calls).toContain("stop")
    expect(test.calls).toContain("release")
  })

  it("doctor 不创建任务控制器且不调用 turn/start", async () => {
    const test = setup()

    const code = await executeCli(["doctor", "--json"], test.dependencies)

    expect(code).toBe(0)
    expect(test.calls).toEqual(["doctor:false"])
    expect(JSON.parse(test.output[0]).codexVersion).toBe("codex-cli 0.131.0")
  })

  it("doctor 文本逐项显示协议能力矩阵", async () => {
    const test = setup()

    const code = await executeCli(["doctor"], test.dependencies)

    expect(code).toBe(0)
    expect(test.output[0]).toContain("Codex version: codex-cli 0.131.0 (TESTED)")
    expect(test.output[0]).toContain("turn/interrupt: schema=DETECTED · runtime=NOT_TESTED")
    expect(test.output[0]).toContain("Goal paused: schema=DETECTED · runtime=NOT_TESTED")
    expect(test.output[0]).toContain("background terminal clean: schema=DETECTED · runtime=NOT_TESTED")
    expect(test.output[0]).toContain("account/rateLimits/read: schema=DETECTED · runtime=VERIFIED")
    expect(test.output[0]).toContain("compatibility basis: generated-schema")
  })
})
