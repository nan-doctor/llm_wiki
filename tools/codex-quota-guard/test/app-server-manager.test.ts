import { describe, expect, it, vi } from "vitest"
import { AppServerManager } from "../src/app-server/manager.js"
import { response, snapshot } from "./fixtures.js"
import { FakeConnectionFactory } from "./fake-app-server.js"

describe("AppServerManager", () => {
  it("严格完成 initialize、initialized 后读取额度", async () => {
    const limits = response(snapshot())
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" })
      connection.respond("account/rateLimits/read", limits)
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })

    await manager.start()

    const connection = factory.connections[0]
    expect(connection.requests.map((request) => request.method)).toEqual([
      "initialize",
      "account/rateLimits/read",
    ])
    expect(connection.notifications).toEqual([{ method: "initialized", params: undefined }])
    expect(manager.currentRateLimits).toEqual(limits)
    await manager.stop()
  })

  it("合并重复 updated 事件并只重新读取一次", async () => {
    vi.useFakeTimers()
    const limits = response(snapshot())
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", limits)
    })
    const manager = new AppServerManager(factory.create, {
      reconnectDelaysMs: [0],
      notificationRefreshDelayMs: 5,
    })
    await manager.start()
    const connection = factory.connections[0]

    connection.emitNotification("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 40 } } })
    connection.emitNotification("account/rateLimits/updated", { rateLimits: { limitId: "codex", primary: { usedPercent: 40 } } })
    await vi.advanceTimersByTimeAsync(5)

    expect(connection.requests.filter((request) => request.method === "account/rateLimits/read")).toHaveLength(2)
    await manager.stop()
    vi.useRealTimers()
  })

  it("App Server 退出后重新建立连接并重新握手读取额度", async () => {
    const limits = response(snapshot())
    const factory = new FakeConnectionFactory((connection) => {
      connection.respond("initialize", {})
      connection.respond("account/rateLimits/read", limits)
    })
    const manager = new AppServerManager(factory.create, { reconnectDelaysMs: [0] })
    await manager.start()

    factory.connections[0].emitExit(new Error("server exited"))
    await manager.waitForIdle()

    expect(factory.connections).toHaveLength(2)
    expect(factory.connections[1].requests.map((request) => request.method)).toEqual([
      "initialize",
      "account/rateLimits/read",
    ])
    await manager.stop()
  })
})
