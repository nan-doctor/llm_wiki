import { EventEmitter, once } from "node:events"
import { describe, expect, it } from "vitest"
import type { GetAccountRateLimitsResponse } from "../src/app-server/protocol.js"
import type { JsonRpcMessage } from "../src/proxy/json-rpc.js"
import {
  InteractiveAppServerClient,
  type InteractiveProxy,
} from "../src/proxy/interactive-app-server-client.js"
import { response, snapshot } from "./fixtures.js"

interface GuardRequest {
  method: string
  params?: unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

class FakeInteractiveProxy extends EventEmitter implements InteractiveProxy {
  readonly guardRequests: GuardRequest[] = []
  turnGateOpened = false

  request<T>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.guardRequests.push({
        method,
        params,
        resolve: (value) => resolve(value as T),
        reject,
      })
      this.emit("guardRequest", method)
    })
  }

  openTurnGate(): void {
    this.turnGateOpened = true
  }

  resolveGuardRequest(index: number, value: unknown): void {
    this.guardRequests[index]!.resolve(value)
  }

  rejectGuardRequest(index: number, error: Error): void {
    this.guardRequests[index]!.reject(error)
  }
}

function createClient(proxy: FakeInteractiveProxy, timeoutMs = 100) {
  return new InteractiveAppServerClient(proxy, {
    sessionGeneration: "session-1",
    initializedTimeoutMs: timeoutMs,
    notificationRefreshDelayMs: 1,
  })
}

describe("InteractiveAppServerClient", () => {
  it("initialized 后先读取额度再释放 turn/start", async () => {
    const proxy = new FakeInteractiveProxy()
    const client = createClient(proxy)
    const start = client.start()

    proxy.emit("tuiNotification", { method: "initialized" } satisfies JsonRpcMessage)
    await Promise.resolve()

    expect(proxy.guardRequests[0]?.method).toBe("account/rateLimits/read")
    expect(proxy.turnGateOpened).toBe(false)
    const limits = response(snapshot())
    proxy.resolveGuardRequest(0, limits)
    await start
    expect(client.currentRateLimits).toEqual(limits)
    expect(proxy.turnGateOpened).toBe(true)
    await client.stop()
  })

  it("合并重复 updated 但仍把每条通知交给控制器观察", async () => {
    const proxy = new FakeInteractiveProxy()
    const client = createClient(proxy)
    const observed: Array<{ method: string; sessionGeneration?: string }> = []
    const rateLimits: GetAccountRateLimitsResponse[] = []
    client.on("notification", (message) => observed.push(message))
    client.on("rateLimits", (limits) => rateLimits.push(limits))
    const start = client.start()
    proxy.emit("tuiNotification", { method: "initialized" })
    await Promise.resolve()
    proxy.resolveGuardRequest(0, response(snapshot()))
    await start

    const refreshStarted = once(proxy, "guardRequest")
    for (let index = 0; index < 3; index += 1) {
      proxy.emit("notification", {
        method: "account/rateLimits/updated",
        params: { index },
      } satisfies JsonRpcMessage)
    }
    await refreshStarted

    expect(proxy.guardRequests).toHaveLength(2)
    const refreshed = response(snapshot({
      credits: { hasCredits: true, unlimited: false, balance: "10" },
    }))
    proxy.resolveGuardRequest(1, refreshed)
    await client.waitForIdle()
    expect(observed).toHaveLength(3)
    expect(observed.every((message) => message.sessionGeneration === "session-1")).toBe(true)
    expect(rateLimits).toEqual([response(snapshot()), refreshed])
    await client.stop()
  })

  it("握手超时不读取额度也不打开 turn 门", async () => {
    const proxy = new FakeInteractiveProxy()
    const client = createClient(proxy, 5)

    await expect(client.start()).rejects.toThrow("等待 TUI initialized 超时")

    expect(proxy.guardRequests).toHaveLength(0)
    expect(proxy.turnGateOpened).toBe(false)
    await client.stop()
  })

  it("握手期间代理退出会拒绝启动", async () => {
    const proxy = new FakeInteractiveProxy()
    const client = createClient(proxy)
    const start = client.start()

    proxy.emit("exit", new Error("App Server 崩溃"))

    await expect(start).rejects.toThrow("App Server 崩溃")
    expect(proxy.turnGateOpened).toBe(false)
    await client.stop()
  })

  it("首次额度读取失败不打开 turn 门", async () => {
    const proxy = new FakeInteractiveProxy()
    const client = createClient(proxy)
    const start = client.start()
    proxy.emit("tuiNotification", { method: "initialized" })
    await Promise.resolve()

    proxy.rejectGuardRequest(0, new Error("额度读取失败"))

    await expect(start).rejects.toThrow("额度读取失败")
    expect(proxy.turnGateOpened).toBe(false)
    await client.stop()
  })

  it("stop 会拒绝尚未完成的 initialized 等待", async () => {
    const proxy = new FakeInteractiveProxy()
    const client = createClient(proxy)
    const start = client.start()

    await client.stop()

    await expect(start).rejects.toThrow("交互额度客户端已停止")
    expect(proxy.turnGateOpened).toBe(false)
  })
})
