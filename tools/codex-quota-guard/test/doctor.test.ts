import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  assessCodexVersion,
  buildCapabilityMatrix,
  classifyDoctorStatus,
  inspectGeneratedProtocol,
  runLiveCanary,
} from "../src/doctor.js"
import { AppServerManager } from "../src/app-server/manager.js"
import { FakeConnectionFactory } from "./fake-app-server.js"
import { response, snapshot } from "./fixtures.js"

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("inspectGeneratedProtocol", () => {
  it("识别 0.131.0 所需额度、turn、Goal 与 terminal 能力", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quota-doctor-test-"))
    roots.push(root)
    await mkdir(path.join(root, "v2"))
    await writeFile(path.join(root, "ClientRequest.json"), JSON.stringify({
      methods: [
        "account/rateLimits/read",
        "turn/start",
        "turn/interrupt",
        "thread/goal/get",
        "thread/goal/set",
        "thread/backgroundTerminals/clean",
      ],
    }))
    await writeFile(path.join(root, "ServerNotification.json"), JSON.stringify({
      methods: ["account/rateLimits/updated", "turn/completed", "item/completed"],
    }))
    await writeFile(path.join(root, "v2", "ThreadGoalSetParams.json"), JSON.stringify({
      definitions: {
        ThreadGoalStatus: { enum: ["active", "paused", "budgetLimited", "complete"] },
      },
    }))

    const capabilities = await inspectGeneratedProtocol(root)

    expect(capabilities).toEqual({
      rateLimitsRead: true,
      rateLimitsUpdated: true,
      turnStart: true,
      turnInterrupt: true,
      goalGet: true,
      goalSet: true,
      goalPaused: true,
      backgroundTerminalsClean: true,
    })
  })

  it("Goal paused 缺失时准确报告降级", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quota-doctor-test-"))
    roots.push(root)
    await writeFile(path.join(root, "schema.json"), JSON.stringify({
      methods: ["account/rateLimits/read", "account/rateLimits/updated", "turn/start", "turn/interrupt"],
    }))

    const capabilities = await inspectGeneratedProtocol(root)

    expect(capabilities.goalPaused).toBe(false)
    expect(capabilities.backgroundTerminalsClean).toBe(false)
  })

  it("无关 schema 出现 paused 时不会误报 Goal paused 能力", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quota-doctor-test-"))
    roots.push(root)
    await mkdir(path.join(root, "v2"))
    await writeFile(path.join(root, "schema.json"), JSON.stringify({ unrelated: "paused" }))
    await writeFile(path.join(root, "v2", "ThreadGoalSetParams.json"), JSON.stringify({
      definitions: {
        ThreadGoalStatus: { enum: ["active", "complete"] },
      },
    }))

    const capabilities = await inspectGeneratedProtocol(root)

    expect(capabilities.goalPaused).toBe(false)
  })
})

describe("classifyDoctorStatus", () => {
  it("只有 weekly、没有 5 小时窗口时为 degraded 而不是 failed", () => {
    expect(classifyDoctorStatus({
      hardCapabilities: true,
      appServerHandshake: true,
      rateLimitsRead: true,
      fiveHourProtectionAvailable: false,
      errors: [],
      warnings: ["five-hour protection unavailable"],
    })).toBe("degraded")
  })
})

describe("assessCodexVersion", () => {
  it("当前已验证版本明确标记为 tested", () => {
    expect(assessCodexVersion("codex-cli 0.131.0", true)).toEqual({
      versionStatus: "tested",
      compatibilityBasis: "generated-schema",
      warning: null,
    })
  })

  it("未知版本仅依据现场 schema，不静默假定兼容", () => {
    expect(assessCodexVersion("codex-cli 0.999.0", true)).toEqual({
      versionStatus: "unknown",
      compatibilityBasis: "generated-schema",
      warning: "Codex 版本 codex-cli 0.999.0 未经过本工具认证；能力结论仅来自当前生成的 schema",
    })
  })
})

describe("buildCapabilityMatrix", () => {
  it("普通 doctor 只把实际读取额度标为 runtime verified", () => {
    const matrix = buildCapabilityMatrix({
      rateLimitsRead: true,
      rateLimitsUpdated: true,
      turnStart: true,
      turnInterrupt: true,
      goalGet: true,
      goalSet: true,
      goalPaused: true,
      backgroundTerminalsClean: true,
    }, { rateLimitsRead: true })

    expect(matrix.rateLimitsRead).toEqual({ schemaDetected: true, runtimeVerified: true })
    expect(matrix.turnStart).toEqual({ schemaDetected: true, runtimeVerified: null })
    expect(matrix.turnInterrupt).toEqual({ schemaDetected: true, runtimeVerified: null })
    expect(matrix.goalPaused).toEqual({ schemaDetected: true, runtimeVerified: null })
  })
})

describe("runLiveCanary", () => {
  it("只启动一个极小 turn，并验证 interrupt、Goal pause/恢复和 terminal clean", async () => {
    vi.useFakeTimers()
    let goal = {
      threadId: "thread-canary",
      objective: "Codex Quota Guard live canary",
      status: "active" as const,
      tokenBudget: 128,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", response(snapshot()))
      connection.respond("thread/start", { thread: { id: "thread-canary" } })
      connection.respond("thread/goal/set", (params: unknown) => {
        const value = params as Partial<typeof goal>
        goal = { ...goal, ...value, threadId: "thread-canary" }
        return { goal }
      })
      connection.respond("thread/goal/get", () => ({ goal }))
      connection.respond("turn/start", async () => {
        setTimeout(() => {
          connection.emitNotification("turn/started", {
            threadId: "thread-canary",
            turn: { id: "turn-canary", items: [], status: "inProgress" },
          })
        }, 6_000)
        await Promise.resolve()
        return { turn: { id: "turn-canary" } }
      })
      connection.respond("turn/interrupt", {})
      connection.respond("thread/backgroundTerminals/clean", {})
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    await manager.start()

    const canaryPromise = runLiveCanary(manager)
    await vi.advanceTimersByTimeAsync(6_000)
    const canary = await canaryPromise

    expect(canary.result).toMatchObject({
      attempted: true,
      threadId: "thread-canary",
      turnId: "turn-canary",
      succeeded: true,
      errors: [],
    })
    expect(canary.runtime).toMatchObject({
      turnStart: true,
      turnInterrupt: true,
      goalGet: true,
      goalSet: true,
      goalPaused: true,
      backgroundTerminalsClean: true,
    })
    const requests = factory.connections[0].requests
    expect(requests.filter((request) => request.method === "turn/start")).toHaveLength(1)
    expect(requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      input: [{ type: "text", text: "请执行 shell 命令 sleep 30，然后只回复 OK" }],
    })
    expect(requests.find((request) => request.method === "turn/interrupt")?.params).toEqual({
      threadId: "thread-canary",
      turnId: "turn-canary",
    })
    const initialGoalSet = requests.findIndex((request) => request.method === "thread/goal/set"
      && (request.params as { status?: string }).status === "active")
    const turnStart = requests.findIndex((request) => request.method === "turn/start")
    const turnInterrupt = requests.findIndex((request) => request.method === "turn/interrupt")
    const pausedGoalSet = requests.findIndex((request) => request.method === "thread/goal/set"
      && (request.params as { status?: string }).status === "paused")
    expect(initialGoalSet).toBeLessThan(turnStart)
    expect(pausedGoalSet).toBeLessThan(turnStart)
    expect(turnStart).toBeLessThan(turnInterrupt)
    expect(goal.status).toBe("active")
    await manager.stop()
  })

  it("Goal 运行时不可用时在 turn/start 前失败，避免消耗真实模型额度", async () => {
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", response(snapshot()))
      connection.respond("thread/start", { thread: { id: "thread-goal-disabled" } })
      connection.respond("turn/start", () => {
        connection.emitNotification("turn/started", {
          threadId: "thread-goal-disabled",
          turn: { id: "turn-goal-disabled", items: [], status: "inProgress" },
        })
        return { turn: { id: "turn-goal-disabled" } }
      })
      connection.respond("turn/interrupt", {})
      connection.respond("thread/goal/set", () => {
        throw new Error("goals feature is disabled")
      })
      connection.respond("thread/backgroundTerminals/clean", {})
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    await manager.start()

    const canary = await runLiveCanary(manager)

    expect(canary.result).toMatchObject({
      threadId: "thread-goal-disabled",
      turnId: null,
      succeeded: false,
    })
    expect(canary.runtime).toMatchObject({
      goalSet: false,
      backgroundTerminalsClean: true,
    })
    expect(canary.runtime.turnStart).toBeUndefined()
    expect(canary.runtime.turnInterrupt).toBeUndefined()
    expect(factory.connections[0].requests.filter((request) => request.method === "turn/start"))
      .toHaveLength(0)
    await manager.stop()
  })

  it("在 turn/start 响应返回前收到 turn/started 时立即中断，避免快速 turn 竞态", async () => {
    let releaseTurnStart: (() => void) | null = null
    let responseReleased = false
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", response(snapshot()))
      connection.respond("thread/start", { thread: { id: "thread-race" } })
      connection.respond("turn/start", async () => {
        connection.emitNotification("turn/started", {
          threadId: "thread-race",
          turn: { id: "turn-race", items: [], status: "inProgress" },
        })
        await new Promise<void>((resolve) => { releaseTurnStart = resolve })
        responseReleased = true
        return { turn: { id: "turn-race" } }
      })
      connection.respond("turn/interrupt", () => {
        expect(responseReleased).toBe(false)
        releaseTurnStart?.()
        return {}
      })
      connection.respond("thread/goal/set", (params: unknown) => ({
        goal: {
          threadId: "thread-race",
          objective: "Codex Quota Guard live canary",
          status: (params as { status: string }).status,
          tokenBudget: 128,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      }))
      let goalStatus = "active"
      connection.respond("thread/goal/set", (params: unknown) => {
        goalStatus = (params as { status: string }).status
        return {}
      })
      connection.respond("thread/goal/get", () => ({
        goal: {
          threadId: "thread-race",
          objective: "Codex Quota Guard live canary",
          status: goalStatus,
          tokenBudget: 128,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      }))
      connection.respond("thread/backgroundTerminals/clean", {})
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    await manager.start()

    const canary = await runLiveCanary(manager)

    expect(canary.result.succeeded).toBe(true)
    expect(canary.result.turnId).toBe("turn-race")
    await manager.stop()
  })

  it("turn/started 缺失时只对 thread/read 唯一确认的 inProgress turn 精确中断", async () => {
    vi.useFakeTimers()
    let goal = {
      threadId: "thread-reconcile",
      objective: "Codex Quota Guard live canary",
      status: "active" as const,
      tokenBudget: 128,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", response(snapshot()))
      connection.respond("thread/start", { thread: { id: "thread-reconcile" } })
      connection.respond("thread/goal/set", (params: unknown) => {
        goal = { ...goal, ...(params as Partial<typeof goal>), threadId: "thread-reconcile" }
        return { goal }
      })
      connection.respond("thread/goal/get", () => ({ goal }))
      connection.respond("turn/start", { turn: { id: "turn-response-id" } })
      connection.respond("thread/read", {
        thread: {
          id: "thread-reconcile",
          turns: [{ id: "turn-runtime-id", status: "inProgress" }],
        },
      })
      connection.respond("turn/interrupt", {})
      connection.respond("thread/backgroundTerminals/clean", {})
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    await manager.start()

    const canaryPromise = runLiveCanary(manager)
    await vi.advanceTimersByTimeAsync(15_000)
    const canary = await canaryPromise

    expect(canary.result).toMatchObject({
      threadId: "thread-reconcile",
      turnId: "turn-runtime-id",
      succeeded: true,
      errors: [],
    })
    expect(factory.connections[0].requests.find((request) => (
      request.method === "turn/interrupt"
    ))?.params).toEqual({
      threadId: "thread-reconcile",
      turnId: "turn-runtime-id",
    })
    await manager.stop()
  })
})
