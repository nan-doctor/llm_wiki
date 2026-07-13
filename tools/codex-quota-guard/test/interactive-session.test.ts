import { EventEmitter } from "node:events"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { describe, expect, it } from "vitest"
import type { GuardController } from "../src/guard/controller.js"
import {
  applyQuotaObservation,
  createInitialState,
  type PersistedGuardState,
  type TurnAdmission,
} from "../src/guard/state-machine.js"
import { normalizeRateLimits } from "../src/quota/normalize.js"
import { emptyCapabilities } from "../src/runtime/capabilities.js"
import type { RuntimeContext } from "../src/runtime/runtime-context.js"
import {
  runInteractivePreflight,
} from "../src/interactive/preflight.js"
import {
  InteractiveSession,
  type InteractiveSessionDependencies,
} from "../src/interactive/session.js"
import {
  TuiProcess,
  type TuiProcessSpawner,
} from "../src/interactive/tui-process.js"
import { response, snapshot, window } from "./fixtures.js"

function runtimeContext(): RuntimeContext {
  const capabilities = emptyCapabilities()
  capabilities.rateLimitsRead = true
  capabilities.rateLimitsUpdated = true
  capabilities.turnStart = true
  capabilities.turnInterrupt = true
  capabilities.threadRead = true
  return {
    executable: {
      codexExecutable: "/absolute/real-codex",
      codexExecutableRealPath: "/absolute/real-codex",
      codexVersion: "codex-cli 1.0.0",
      executableSelectionSource: "path",
      launchAllowed: true,
      discoveredCandidates: [],
    },
    protocolFingerprint: "fingerprint",
    schemaCapabilities: capabilities,
    capabilityMatrix: {} as RuntimeContext["capabilityMatrix"],
    remoteCapabilities: {
      remoteTui: true,
      remoteAuthTokenEnv: true,
      remoteUnixSocket: true,
      remoteLoopbackWebSocket: true,
      appServerStdio: true,
    },
  }
}

function preflightState(kind: "armed" | "dormant" | "awaiting" | "handled"): PersistedGuardState {
  const limits = kind === "dormant"
    ? response(snapshot({
        primary: window(98, 8_000, 10_080),
        secondary: null,
      }))
    : kind === "awaiting"
    ? response(snapshot({
        primary: window(98.5, 2_000, 300),
        secondary: window(40, 8_000, 10_080),
      }))
    : kind === "handled"
    ? response(snapshot({
        primary: window(98.5, 2_000, 300),
        secondary: window(40, 8_000, 10_080),
      }))
    : response(snapshot({
        primary: window(80, 2_000, 300),
        secondary: window(40, 8_000, 10_080),
      }))
  let state = applyQuotaObservation(
    createInitialState(),
    normalizeRateLimits(limits, 10_000),
    null,
    10_000,
  ).state
  if (kind === "handled") {
    state = applyQuotaObservation(
      applyQuotaObservation(
        createInitialState(),
        normalizeRateLimits(response(snapshot({
          primary: window(80, 2_000, 300),
          secondary: window(40, 8_000, 10_080),
        })), 9_000),
        null,
        9_000,
      ).state,
      normalizeRateLimits(limits, 10_000),
      null,
      10_000,
    ).state
  }
  return state
}

function fakePreflightController(
  state: PersistedGuardState,
  admission: TurnAdmission = "ALLOWED",
): { controller: GuardController; starts: () => number; stops: () => number } {
  let startCount = 0
  let stopCount = 0
  const controller = {
    async start() { startCount += 1 },
    async stop() { stopCount += 1 },
    status() { return { state, admission } },
  } as unknown as GuardController
  return {
    controller,
    starts: () => startCount,
    stops: () => stopCount,
  }
}

describe("交互预检", () => {
  it.each([
    ["dormant", false, true],
    ["dormant", true, false],
    ["awaiting", true, false],
    ["armed", true, true],
  ] as const)("状态 %s、严格=%s 时准入=%s", async (kind, strict, allowed) => {
    const fake = fakePreflightController(preflightState(kind))
    const result = runInteractivePreflight(fake.controller, {
      requireProtection: strict,
      runtimeContext: runtimeContext(),
      now: () => 10_100,
    })

    if (allowed) await expect(result).resolves.toBeDefined()
    else await expect(result).rejects.toThrow(/5 小时保护/)
    expect(fake.starts()).toBe(1)
    expect(fake.stops()).toBe(1)
  })

  it("DORMANT 文本保留 weekly 信息并明确 ALLOWED", async () => {
    const fake = fakePreflightController(preflightState("dormant"))
    const result = await runInteractivePreflight(fake.controller, {
      requireProtection: false,
      runtimeContext: runtimeContext(),
      now: () => 10_100,
    })

    expect(result.text).toContain("Codex Quota Guard: active")
    expect(result.text).toContain("Codex executable: /absolute/real-codex")
    expect(result.text).toContain("weekly: 98% used · 2% left")
    expect(result.text).toContain("weekly: informational only")
    expect(result.text).toContain("guard: DORMANT")
    expect(result.text).toContain("turns: ALLOWED")
    expect(result.text).toContain("Bypass: codex-raw")
  })

  it("CRITICAL + HANDLED 同时显示后续任务允许且不出现 STOPPED", async () => {
    const fake = fakePreflightController(preflightState("handled"))
    const result = await runInteractivePreflight(fake.controller, {
      requireProtection: false,
      runtimeContext: runtimeContext(),
      now: () => 10_100,
    })

    expect(result.text).toContain("quota: CRITICAL")
    expect(result.text).toContain("guard: HANDLED")
    expect(result.text).toContain("turns: ALLOWED")
    expect(result.text).not.toContain("STOPPED")
  })
})

class FakeChild extends EventEmitter {
  killed = false
  killSignals: Array<NodeJS.Signals | number | undefined> = []

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    this.killSignals.push(signal)
    return true
  }
}

describe("TuiProcess", () => {
  it("只通过环境传递 token 并固定 remote 参数", async () => {
    const child = new FakeChild()
    let captured: {
      executable: string
      args: string[]
      options: SpawnOptions
    } | null = null
    const spawner: TuiProcessSpawner = (executable, args, options) => {
      captured = { executable, args, options }
      queueMicrotask(() => child.emit("spawn"))
      return child as unknown as ChildProcess
    }
    const tui = new TuiProcess({
      executable: "/path with spaces/node",
      codexArgsPrefix: ["/path with spaces/fake-codex.mjs"],
      remoteAddress: "unix:///tmp/guard.sock",
      tokenEnvironmentName: "CODEX_QUOTA_GUARD_REMOTE_TOKEN",
      token: "secret-token",
      tuiArgs: ["--model", "gpt-test"],
      environment: { SAFE: "kept" },
    }, spawner)

    await tui.start()

    expect(captured).toMatchObject({
      executable: "/path with spaces/node",
      args: [
        "/path with spaces/fake-codex.mjs",
        "--remote",
        "unix:///tmp/guard.sock",
        "--remote-auth-token-env",
        "CODEX_QUOTA_GUARD_REMOTE_TOKEN",
        "--model",
        "gpt-test",
      ],
      options: {
        stdio: "inherit",
        windowsHide: true,
        env: {
          SAFE: "kept",
          CODEX_QUOTA_GUARD_REMOTE_TOKEN: "secret-token",
        },
      },
    })
    expect(captured!.args).not.toContain("secret-token")
    const exit = tui.waitForExit()
    child.emit("exit", 7, null)
    await expect(exit).resolves.toEqual({ code: 7, signal: null })
    await tui.stop()
    expect(JSON.stringify(tui)).not.toContain("secret-token")
  })
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class OrderedRaw extends EventEmitter {
  stopCount = 0
  constructor(private readonly order: string[]) { super() }
  async start() { this.order.push("raw:start") }
  async stop() { this.stopCount += 1; this.order.push("raw:stop") }
}

class OrderedEndpoint extends EventEmitter {
  readonly address = "unix:///tmp/fake.sock"
  closeCount = 0
  stopCount = 0
  constructor(private readonly order: string[]) { super() }
  send() {}
  async closeClient() { this.closeCount += 1; this.order.push("endpoint:close-client") }
  async stop() { this.stopCount += 1; this.order.push("endpoint:stop") }
}

class OrderedProxy extends EventEmitter {
  pauseCount = 0
  stopCount = 0
  constructor(private readonly order: string[]) { super() }
  start() { this.order.push("proxy:start") }
  pauseDownstream() { this.pauseCount += 1; this.order.push("proxy:pause") }
  stop() { this.stopCount += 1; this.order.push("proxy:stop") }
}

class OrderedController {
  stopCount = 0
  shutdownCount = 0
  readonly ready = deferred<void>()
  constructor(private readonly order: string[]) {}
  async start() {
    this.order.push("controller:start")
    await this.ready.promise
    this.order.push("controller:ready")
  }
  async shutdownInteractiveSession() {
    this.shutdownCount += 1
    this.order.push("controller:shutdown")
  }
  async stop() { this.stopCount += 1; this.order.push("controller:stop") }
}

class OrderedTui extends EventEmitter {
  stopCount = 0
  readonly exited = deferred<{ code: number | null; signal: NodeJS.Signals | null }>()
  constructor(
    private readonly order: string[],
    private readonly controller: OrderedController,
    private readonly afterStart: () => void,
  ) { super() }
  async start() {
    this.order.push("tui:start")
    this.controller.ready.resolve()
    queueMicrotask(this.afterStart)
  }
  async waitForExit() { return await this.exited.promise }
  async stop() { this.stopCount += 1; this.order.push("tui:stop") }
}

class SignalSource extends EventEmitter {
  off(eventName: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(eventName, listener)
  }
}

function sessionHarness(trigger: "normal" | "crash" | "sigint" | "sighup" | "raw" | "proxy" | "endpoint") {
  const order: string[] = []
  const raw = new OrderedRaw(order)
  const endpoint = new OrderedEndpoint(order)
  const proxy = new OrderedProxy(order)
  const controller = new OrderedController(order)
  const signals = new SignalSource()
  let capturedTuiOptions: Record<string, unknown> | null = null
  const tui = new OrderedTui(order, controller, () => {
    if (trigger === "normal") tui.exited.resolve({ code: 0, signal: null })
    else if (trigger === "crash") tui.exited.resolve({ code: 7, signal: null })
    else if (trigger === "sigint") signals.emit("SIGINT")
    else if (trigger === "sighup") signals.emit("SIGHUP")
    else if (trigger === "raw") raw.emit("exit", new Error("App Server 崩溃"))
    else if (trigger === "proxy") proxy.emit("exit", new Error("代理崩溃"))
    else endpoint.emit("close")
  })
  const dependencies: InteractiveSessionDependencies = {
    async runPreflight() {
      order.push("preflight:start")
      order.push("preflight:stop")
    },
    raw,
    createToken() {
      order.push("token:create")
      return "session-secret"
    },
    async createEndpoint() {
      order.push("endpoint:start")
      return endpoint
    },
    createProxy() { return proxy },
    createController() { return controller },
    createTui(options) {
      capturedTuiOptions = { ...options }
      return tui
    },
    tokenEnvironmentName: "CODEX_QUOTA_GUARD_REMOTE_TOKEN",
    signalSource: signals,
  }
  return {
    order,
    raw,
    endpoint,
    proxy,
    controller,
    tui,
    dependencies,
    capturedTuiOptions: () => capturedTuiOptions,
  }
}

describe("InteractiveSession", () => {
  it("TUI 正常退出前 WebSocket 先关闭时以进程退出码为准", async () => {
    const test = sessionHarness("endpoint")
    const originalStart = test.tui.start.bind(test.tui)
    test.tui.start = async () => {
      await originalStart()
      queueMicrotask(() => test.tui.exited.resolve({ code: 0, signal: null }))
    }
    const session = new InteractiveSession(test.dependencies)

    await expect(session.run({ tuiArgs: [], requireProtection: false })).resolves.toBe(0)
  })

  it("等待 controller 确认握手订阅后才启动 TUI", async () => {
    const test = sessionHarness("normal")
    let subscribed = false
    test.dependencies.createController = () => ({
      start: async () => await test.controller.start(),
      waitUntilListening: async () => {
        await Promise.resolve()
        subscribed = true
      },
      shutdownInteractiveSession: async () => await test.controller.shutdownInteractiveSession(),
      stop: async () => await test.controller.stop(),
    })
    const originalStart = test.tui.start.bind(test.tui)
    test.tui.start = async () => {
      expect(subscribed).toBe(true)
      await originalStart()
    }
    const session = new InteractiveSession(test.dependencies)

    await expect(session.run({ tuiArgs: [], requireProtection: false })).resolves.toBe(0)
  })

  it("严格遵守启动与唯一逆序清理路径且 token 只交给 TUI", async () => {
    const test = sessionHarness("normal")
    const session = new InteractiveSession(test.dependencies)

    await expect(session.run({ tuiArgs: ["--model", "gpt-test"], requireProtection: false }))
      .resolves.toBe(0)

    expect(test.order).toEqual([
      "preflight:start",
      "preflight:stop",
      "raw:start",
      "token:create",
      "endpoint:start",
      "proxy:start",
      "controller:start",
      "tui:start",
      "controller:ready",
      "proxy:pause",
      "controller:shutdown",
      "controller:stop",
      "proxy:stop",
      "endpoint:close-client",
      "tui:stop",
      "raw:stop",
      "endpoint:stop",
    ])
    expect(test.capturedTuiOptions()).toEqual({
      remoteAddress: "unix:///tmp/fake.sock",
      tokenEnvironmentName: "CODEX_QUOTA_GUARD_REMOTE_TOKEN",
      token: "session-secret",
      tuiArgs: ["--model", "gpt-test"],
    })
    expect(test.raw.stopCount).toBe(1)
    expect(test.endpoint.stopCount).toBe(1)
    expect(test.proxy.stopCount).toBe(1)
    expect(test.proxy.pauseCount).toBe(1)
    expect(test.controller.shutdownCount).toBe(1)
    expect(test.controller.stopCount).toBe(1)
    expect(test.tui.stopCount).toBe(1)
  })

  it.each([
    ["normal", 0],
    ["crash", 7],
    ["sigint", 130],
    ["sighup", 129],
    ["raw", 1],
    ["proxy", 1],
    ["endpoint", 1],
  ] as const)("%s 退出路径清理每个组件一次并返回 %i", async (trigger, code) => {
    const test = sessionHarness(trigger)
    const session = new InteractiveSession(test.dependencies)

    await expect(session.run({ tuiArgs: [], requireProtection: false })).resolves.toBe(code)

    expect(test.raw.stopCount).toBe(1)
    expect(test.endpoint.closeCount).toBe(1)
    expect(test.endpoint.stopCount).toBe(1)
    expect(test.proxy.stopCount).toBe(1)
    expect(test.proxy.pauseCount).toBe(1)
    expect(test.controller.shutdownCount).toBe(1)
    expect(test.controller.stopCount).toBe(1)
    expect(test.tui.stopCount).toBe(1)
  })
})
