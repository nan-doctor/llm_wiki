import { describe, expect, it } from "vitest"
import { AppServerManager } from "../src/app-server/manager.js"
import { buildCapabilityMatrix, type ProtocolCapabilities } from "../src/doctor.js"
import { GuardController, type GuardControllerOptions } from "../src/guard/controller.js"
import {
  applyQuotaObservation,
  completeThresholdHandling,
  createInitialState,
  type PersistedGuardState,
} from "../src/guard/state-machine.js"
import type { GuardStateRepository } from "../src/persistence/repository.js"
import { normalizeRateLimits } from "../src/quota/normalize.js"
import type { ThresholdReporter } from "../src/report/reporter.js"
import { response, snapshot, window } from "./fixtures.js"
import { FakeConnectionFactory } from "./fake-app-server.js"
import type { RuntimeContext } from "../src/runtime/runtime-context.js"

class MemoryRepository implements GuardStateRepository {
  state: PersistedGuardState | null = null
  async load(): Promise<PersistedGuardState | null> {
    return this.state ? structuredClone(this.state) : null
  }
  async save(state: PersistedGuardState): Promise<void> {
    this.state = structuredClone(state)
  }
}

class MemoryReporter implements ThresholdReporter {
  readonly eventIds: string[] = []
  async write(state: PersistedGuardState): Promise<void> {
    if (state.lastThresholdEvent) this.eventIds.push(state.lastThresholdEvent.id)
  }
}

function setup(controllerOptions: GuardControllerOptions = {}) {
  let currentLimits = response(snapshot({
    primary: window(80, 8_000, 10_080),
    secondary: window(80, 2_000, 300),
  }))
  let nextTurn = 1
  const factory = new FakeConnectionFactory((connection) => {
    connection.respond("initialize", {})
    connection.respond("account/rateLimits/read", () => currentLimits)
    connection.respond("thread/start", { thread: { id: "thread-1" } })
    connection.respond("thread/resume", (params: unknown) => ({ thread: { id: (params as { threadId: string }).threadId } }))
    connection.respond("turn/start", () => ({ turn: { id: `turn-${nextTurn++}`, status: "inProgress", items: [] } }))
    connection.respond("turn/interrupt", {})
    connection.respond("thread/backgroundTerminals/clean", {})
    connection.respond("thread/goal/get", {
      goal: {
        threadId: "thread-1",
        objective: "完成任务",
        status: "active",
        tokenBudget: 10_000,
        tokensUsed: 100,
        timeUsedSeconds: 5,
        createdAt: 1,
        updatedAt: 2,
      },
    })
    connection.respond("thread/goal/set", (params: unknown) => ({ goal: params }))
  })
  const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
  const repository = new MemoryRepository()
  const reporter = new MemoryReporter()
  const controller = new GuardController(manager, repository, reporter, {
    now: () => 20_000,
    ...controllerOptions,
  })
  return {
    manager,
    repository,
    reporter,
    controller,
    factory,
    setLimits(value: typeof currentLimits) { currentLimits = value },
  }
}

const criticalLimits = () => response(snapshot({
  primary: window(80, 8_000, 10_080),
  secondary: window(98, 2_000, 300),
}))

function runtimeContext(options: {
  realPath?: string
  version?: string
  fingerprint?: string
  turnInterrupt?: boolean
} = {}): RuntimeContext {
  const schemaCapabilities: ProtocolCapabilities = {
    rateLimitsRead: true,
    rateLimitsUpdated: true,
    turnStart: true,
    turnInterrupt: options.turnInterrupt ?? true,
    threadRead: true,
    goalGet: true,
    goalSet: true,
    goalPaused: true,
    goalResume: true,
    backgroundTerminalsClean: true,
    serverRequestHandling: true,
  }
  return {
    executable: {
      codexExecutable: "/selected/codex",
      codexExecutableRealPath: options.realPath ?? "/real/selected/codex",
      codexVersion: options.version ?? "codex-cli 1.0.0",
      executableSelectionSource: "path",
      launchAllowed: true,
      discoveredCandidates: [],
    },
    protocolFingerprint: options.fingerprint ?? "fingerprint-1",
    schemaCapabilities,
    capabilityMatrix: buildCapabilityMatrix(schemaCapabilities),
  }
}

function resumableStateWithRuntime(context: RuntimeContext): PersistedGuardState {
  let state = applyQuotaObservation(createInitialState(), normalizeRateLimits(response(snapshot({
    primary: window(80, 2_000, 300),
    secondary: window(40, 8_000, 10_080),
  })), 10_000), null, 10_000).state
  const target = { threadId: "thread-1", turnId: "turn-old", startedAt: 10_100 }
  const handling = applyQuotaObservation(
    state,
    normalizeRateLimits(criticalLimits(), 11_000),
    target,
    11_000,
  )
  state = completeThresholdHandling(handling.state, handling.event!.id, 11_100)
  const runtime = {
    task: {
      codexExecutable: context.executable.codexExecutable,
      codexExecutableRealPath: context.executable.codexExecutableRealPath!,
      codexVersion: context.executable.codexVersion!,
      protocolFingerprint: context.protocolFingerprint!,
    },
    current: null,
    capabilities: buildCapabilityMatrix(context.schemaCapabilities, { turnInterrupt: true }),
    changes: [],
  }
  ;(state as unknown as { runtime: typeof runtime }).runtime = runtime
  return state
}

describe("GuardController", () => {
  it("run 保存创建任务所用的运行身份", async () => {
    const context = runtimeContext()
    const test = setup({ runtimeContext: context } as GuardControllerOptions & {
      runtimeContext: RuntimeContext
    })
    await test.controller.start()

    await test.controller.run("保存运行身份")

    expect((test.repository.state as unknown as { runtime: { task: unknown } }).runtime.task)
      .toEqual({
        codexExecutable: "/selected/codex",
        codexExecutableRealPath: "/real/selected/codex",
        codexVersion: "codex-cli 1.0.0",
        protocolFingerprint: "fingerprint-1",
      })
    await test.controller.stop()
  })

  it.each([
    ["codexExecutableRealPath", runtimeContext({ realPath: "/real/new/codex" })],
    ["codexVersion", runtimeContext({ version: "codex-cli 2.0.0" })],
    ["protocolFingerprint", runtimeContext({ fingerprint: "fingerprint-2" })],
  ] as const)("resume 检测 %s 变化并丢弃旧运行时证据", async (field, current) => {
    const previous = runtimeContext()
    const test = setup({ runtimeContext: current } as GuardControllerOptions & {
      runtimeContext: RuntimeContext
    })
    test.repository.state = resumableStateWithRuntime(previous)
    await test.controller.start()

    await test.controller.resume()

    const runtime = (test.repository.state as unknown as {
      runtime: {
        changes: Array<{ field: string }>
        capabilities: { turnInterrupt: { runtimeVerified: boolean | null } }
      }
    }).runtime
    expect(runtime.changes).toContainEqual(expect.objectContaining({ field }))
    expect(runtime.capabilities.turnInterrupt.runtimeVerified).toBeNull()
    await test.controller.stop()
  })

  it("resume 在新运行环境缺少核心 interrupt schema 时拒绝", async () => {
    const previous = runtimeContext()
    const current = runtimeContext({ fingerprint: "fingerprint-2", turnInterrupt: false })
    const test = setup({ runtimeContext: current } as GuardControllerOptions & {
      runtimeContext: RuntimeContext
    })
    test.repository.state = resumableStateWithRuntime(previous)
    await test.controller.start()

    await expect(test.controller.resume()).rejects.toThrow("核心保护能力不可用：turn/interrupt")
    expect(test.factory.connections[0].requests.some((request) => request.method === "thread/resume"))
      .toBe(false)
    await test.controller.stop()
  })

  it("只有 weekly 时 DORMANT 但允许启动 turn", async () => {
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", response(snapshot({
        primary: window(80, 8_000, 10_080),
        secondary: null,
      })))
      connection.respond("thread/start", { thread: { id: "thread-known" } })
      connection.respond("turn/start", { turn: { id: "turn-known" } })
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    const controller = new GuardController(manager, new MemoryRepository(), new MemoryReporter(), {
      now: () => 20_000,
    })
    await controller.start()

    await expect(controller.run("weekly-only 仍允许")).resolves.toEqual({
      threadId: "thread-known",
      turnId: "turn-known",
    })
    expect(controller.status().state.guard.state).toBe("DORMANT")
    expect(controller.status().admission).toBe("ALLOWED")
    await controller.stop()
  })

  it("只有显式 requireProtection 时 weekly-only 拒绝 run", async () => {
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", response(snapshot({
        primary: window(80, 8_000, 10_080),
        secondary: null,
      })))
      connection.respond("thread/start", { thread: { id: "thread-must-not-start" } })
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    const controller = new GuardController(manager, new MemoryRepository(), new MemoryReporter())
    await controller.start()

    await expect(controller.run("严格保护任务", {
      requireProtection: true,
    })).rejects.toThrow("5 小时保护当前不可用")
    expect(factory.connections[0].requests.some((request) => request.method === "thread/start"))
      .toBe(false)
    await controller.stop()
  })

  it("awaitingBaseline 时严格 run 拒绝但默认 run 仍允许", async () => {
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", response(snapshot({
        primary: window(98.5, 2_000, 300),
        secondary: window(40, 8_000, 10_080),
      })))
      connection.respond("thread/start", { thread: { id: "thread-baseline" } })
      connection.respond("turn/start", { turn: { id: "turn-baseline" } })
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    const controller = new GuardController(manager, new MemoryRepository(), new MemoryReporter())
    await controller.start()

    await expect(controller.run("严格冷启动", {
      requireProtection: true,
    })).rejects.toThrow("5 小时保护仍在等待安全基线")
    await expect(controller.run("默认冷启动")).resolves.toEqual({
      threadId: "thread-baseline",
      turnId: "turn-baseline",
    })
    expect(factory.connections[0].requests.filter((request) => request.method === "thread/start"))
      .toHaveLength(1)
    await controller.stop()
  })

  it("resume 继承原严格保护策略并在 5 小时窗口不可见时拒绝", async () => {
    const repository = new MemoryRepository()
    let state = applyQuotaObservation(createInitialState(), normalizeRateLimits(response(snapshot({
      primary: window(80, 2_000, 300),
      secondary: window(40, 8_000, 10_080),
    })), 10_000), null, 10_000).state
    const target = { threadId: "thread-strict", turnId: "turn-strict", startedAt: 10_100 }
    const handling = applyQuotaObservation(state, normalizeRateLimits(criticalLimits(), 11_000), target, 11_000)
    state = completeThresholdHandling(handling.state, handling.event!.id, 11_100)
    state.limits.requireProtection = true
    repository.state = state
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", response(snapshot({
        primary: window(40, 8_000, 10_080),
        secondary: null,
      })))
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    const controller = new GuardController(manager, repository, new MemoryReporter())
    await controller.start()

    await expect(controller.resume("继续严格任务"))
      .rejects.toThrow("5 小时保护当前不可用")
    expect(factory.connections[0].requests.some((request) => request.method === "thread/resume"))
      .toBe(false)
    await controller.stop()
  })

  it("5 小时窗口稍后出现时控制器自动 ARMED", async () => {
    const limits = response(snapshot({
      primary: window(80, 8_000, 10_080),
      secondary: null,
    }))
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", limits)
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    const controller = new GuardController(manager, new MemoryRepository(), new MemoryReporter(), {
    })
    await controller.start()
    expect(controller.status().state.guard.state).toBe("DORMANT")
    factory.connections[0].respond("account/rateLimits/read", response(snapshot({
      primary: window(80, 8_000, 10_080),
      secondary: window(80, 2_000, 300),
    })))

    await controller.refreshAndHandleQuota()

    expect(controller.status().state.guard.state).toBe("ARMED")
    await controller.stop()
  })

  it("等待固定 turn 的完成通知", async () => {
    const test = setup()
    await test.controller.start()
    const started = await test.controller.run("单轮任务")

    const waiting = test.controller.waitForTurn(started)
    test.factory.connections[0].emitNotification("turn/completed", {
      threadId: started.threadId,
      turn: { id: started.turnId, status: "completed" },
    })

    await expect(waiting).resolves.toBe("completed")
    await test.controller.stop()
  })

  it("turn 失败时保存服务端错误并返回 failed 状态", async () => {
    const test = setup()
    await test.controller.start()
    const started = await test.controller.run("失败任务")
    const waiting = test.controller.waitForTurn(started)

    test.factory.connections[0].emitNotification("turn/completed", {
      threadId: started.threadId,
      turn: {
        id: started.turnId,
        status: "failed",
        error: { message: "交互式审批请求不受支持" },
      },
    })

    await expect(waiting).resolves.toBe("failed")
    await test.controller.waitForIdle()
    expect(test.repository.state?.errors).toContain("turn 失败：交互式审批请求不受支持")
    await test.controller.stop()
  })

  it("turn/completed 早于 turn/start 响应时仍返回真实完成状态且不重复中断", async () => {
    const test = setup()
    await test.controller.start()
    const connection = test.factory.connections[0]
    connection.respond("turn/start", () => {
      connection.emitNotification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-early", status: "completed" },
      })
      return { turn: { id: "turn-early", status: "inProgress", items: [] } }
    })

    const started = await test.controller.run("快速完成任务")

    await expect(test.controller.waitForTurn(started, 10)).resolves.toBe("completed")
    expect(connection.requests.filter((request) => request.method === "turn/interrupt"))
      .toHaveLength(0)
    await test.controller.stop()
  })

  it("turn/start 响应 ID 与运行时 ID 不同时保存 thread/read 唯一活动 turn", async () => {
    const test = setup()
    await test.controller.start()
    const connection = test.factory.connections[0]
    connection.respond("turn/start", {
      turn: { id: "turn-response-id", status: "inProgress", items: [] },
    })
    connection.respond("thread/read", {
      thread: {
        id: "thread-1",
        turns: [{ id: "turn-runtime-id", status: "inProgress" }],
      },
    })

    const started = await test.controller.run("运行时 ID 对账")

    expect(started).toEqual({ threadId: "thread-1", turnId: "turn-runtime-id" })
    expect(test.repository.state?.activeTurn?.turnId).toBe("turn-runtime-id")
    await test.controller.stop()
  })

  it("最大运行时间只中断该次固定 turn", async () => {
    const test = setup()
    await test.controller.start()
    const started = await test.controller.run("限时任务")

    await expect(test.controller.waitForTurn(started, 1)).resolves.toBe("interrupted")

    const interrupts = test.factory.connections[0].requests.filter((request) => request.method === "turn/interrupt")
    expect(interrupts.at(-1)?.params).toEqual(started)
    await test.controller.stop()
  })

  it("只中断阈值瞬间快照中的原 turn，HANDLED 后新 turn 允许继续", async () => {
    const test = setup()
    await test.controller.start()
    const old = await test.controller.run("第一步")
    test.setLimits(criticalLimits())

    await test.controller.refreshAndHandleQuota()
    const next = await test.controller.run("恢复后的新步骤", { threadId: old.threadId })

    const requests = test.factory.connections[0].requests
    const interrupts = requests.filter((request) => request.method === "turn/interrupt")
    expect(interrupts).toEqual([{
      method: "turn/interrupt",
      params: { threadId: old.threadId, turnId: old.turnId },
    }])
    expect(next.turnId).not.toBe(old.turnId)
    expect(test.repository.state?.guard.state).toBe("HANDLED")
    expect(test.controller.status().admission).toBe("ALLOWED")
    await test.controller.stop()
  })

  it("阈值处理与新 turn 串行，事件之后的 turn 不会被误中断", async () => {
    const test = setup()
    await test.controller.start()
    const old = await test.controller.run("旧 turn")
    test.setLimits(criticalLimits())

    const handling = test.controller.refreshAndHandleQuota()
    const starting = test.controller.run("新 turn", { threadId: old.threadId })
    const [, next] = await Promise.all([handling, starting])

    const interrupts = test.factory.connections[0].requests.filter((request) => request.method === "turn/interrupt")
    expect(interrupts).toHaveLength(1)
    expect(interrupts[0].params).toEqual({ threadId: old.threadId, turnId: old.turnId })
    expect(next.turnId).not.toBe(old.turnId)
    await test.controller.stop()
  })

  it("重复 CRITICAL 更新不会重复 interrupt", async () => {
    const test = setup()
    await test.controller.start()
    await test.controller.run("旧 turn")
    test.setLimits(criticalLimits())

    await test.controller.refreshAndHandleQuota()
    await test.controller.refreshAndHandleQuota()

    const interrupts = test.factory.connections[0].requests.filter((request) => request.method === "turn/interrupt")
    expect(interrupts).toHaveLength(1)
    expect(test.reporter.eventIds).toHaveLength(1)
    await test.controller.stop()
  })

  it("weekly 98% used 但 5 小时窗口安全时不发送 interrupt", async () => {
    const test = setup()
    await test.controller.start()
    await test.controller.run("weekly 低额度任务")
    test.setLimits(response(snapshot({
      primary: window(98, 9_000, 10_080),
      secondary: window(80, 2_000, 300),
    })))

    await test.controller.refreshAndHandleQuota()

    const interrupts = test.factory.connections[0].requests.filter((request) => request.method === "turn/interrupt")
    expect(interrupts).toHaveLength(0)
    expect(test.controller.status().state.guard.state).toBe("ARMED")
    await test.controller.stop()
  })

  it("resume 恢复原 Goal 但从不清除 Goal", async () => {
    const test = setup()
    await test.controller.start()
    await test.controller.run("旧 turn")
    test.setLimits(criticalLimits())
    await test.controller.refreshAndHandleQuota()

    const resumed = await test.controller.resume("继续")

    expect(resumed?.turnId).toBeDefined()
    const requests = test.factory.connections[0].requests
    expect(requests.some((request) => request.method === "thread/goal/clear")).toBe(false)
    const goalSets = requests.filter((request) => request.method === "thread/goal/set")
    expect(goalSets.some((request) => (request.params as { status?: string }).status === "paused")).toBe(true)
    expect(goalSets.some((request) => (request.params as { status?: string }).status === "active")).toBe(true)
    await test.controller.stop()
  })

  it("Goal 运行时不可用时仍完成固定 turn 中断、terminal 清理和本地报告", async () => {
    const test = setup()
    await test.controller.start()
    const started = await test.controller.run("Goal 降级任务")
    test.factory.connections[0].respond("thread/goal/get", () => {
      throw new Error("no such table: thread_goals")
    })
    test.setLimits(criticalLimits())

    await test.controller.refreshAndHandleQuota()

    const state = test.controller.status().state
    expect(state.guard.state).toBe("HANDLED")
    expect(state.lastThresholdEvent).toMatchObject({
      target: started,
      interruptSucceeded: true,
      goalPaused: false,
      backgroundTerminalsCleaned: true,
    })
    expect(state.lastThresholdEvent?.errors).toContain("no such table: thread_goals")
    expect(test.reporter.eventIds).toHaveLength(1)
    await test.controller.stop()
  })

  it("没有可恢复中断记录时 resume 明确报错", async () => {
    const test = setup()
    test.repository.state = createInitialState()
    await test.controller.start()

    await expect(test.controller.resume("继续")).rejects.toThrow("没有可恢复的中断记录，请改用 run")
    await test.controller.stop()
  })

  it("本次设置 maxTurns 时先应用限制再决定是否允许", async () => {
    const test = setup()
    await test.controller.start()
    await test.controller.run("第一个 turn")

    await expect(test.controller.run("第二个 turn", {
      threadId: "thread-1",
      maxTurns: 1,
    })).rejects.toThrow("已达到最大 turn 数量")
    await test.controller.stop()
  })

  it("App Server 重连后续接保存的 thread 并对账固定 active turn", async () => {
    const test = setup()
    await test.controller.start()
    const started = await test.controller.run("重连任务")

    test.factory.connections[0].emitExit(new Error("server exited"))
    await test.manager.waitForIdle()
    await test.controller.waitForIdle()

    const reconnectRequests = test.factory.connections[1].requests
    expect(reconnectRequests.some((request) => request.method === "thread/resume"
      && (request.params as { threadId?: string }).threadId === started.threadId)).toBe(true)
    expect(test.controller.status().state.activeTurn?.turnId).toBe(started.turnId)
    await test.controller.stop()
  })

  it("保存 App Server 诊断供状态与本地报告使用", async () => {
    const test = setup()
    await test.controller.start()

    test.manager.emit("diagnostic", "已拒绝不支持的 App Server 请求：item/tool/requestUserInput")
    await test.controller.waitForIdle()

    expect(test.repository.state?.errors).toContain(
      "已拒绝不支持的 App Server 请求：item/tool/requestUserInput",
    )
    await test.controller.stop()
  })

  it("HANDLING 崩溃恢复时重复 interrupt 按幂等成功处理固定原 turn", async () => {
    const test = setup()
    let state = applyQuotaObservation(
      createInitialState(),
      normalizeRateLimits(response(snapshot({
        primary: window(80, 8_000, 10_080),
        secondary: window(80, 2_000, 300),
      })), 10_000),
      null,
      10_000,
    ).state
    const fixed = { threadId: "thread-1", turnId: "turn-fixed", startedAt: 10_100 }
    state = applyQuotaObservation(state, normalizeRateLimits(criticalLimits(), 11_000), fixed, 11_000).state
    test.repository.state = state
    test.factory.connections.length = 0

    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", response(snapshot({
        primary: window(80, 8_000, 10_080),
        secondary: window(80, 2_000, 300),
      })))
      connection.respond("turn/interrupt", () => { throw new Error("already interrupted") })
      connection.respond("thread/goal/get", { goal: null })
      connection.respond("thread/backgroundTerminals/clean", {})
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    const repository = new MemoryRepository()
    repository.state = state
    const controller = new GuardController(manager, repository, new MemoryReporter(), {
      now: () => 20_000,
    })

    await controller.start()

    expect(repository.state?.guard.state).toBe("HANDLED")
    expect(repository.state?.lastThresholdEvent?.target?.turnId).toBe("turn-fixed")
    expect(repository.state?.lastThresholdEvent?.interruptSucceeded).toBe(true)
    await controller.stop()
  })
})
