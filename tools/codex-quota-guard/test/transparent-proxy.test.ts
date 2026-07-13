import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import type { JsonRpcMessage } from "../src/proxy/json-rpc.js"
import {
  TransparentJsonRpcProxy,
  type JsonRpcPeer,
} from "../src/proxy/transparent-proxy.js"

class MemoryPeer extends EventEmitter implements JsonRpcPeer {
  readonly sent: JsonRpcMessage[] = []

  send(message: JsonRpcMessage): void {
    this.sent.push(structuredClone(message))
  }

  emitMessage(message: JsonRpcMessage): void {
    this.emit("message", structuredClone(message))
  }
}

function setup(requestTimeoutMs = 100) {
  const downstream = new MemoryPeer()
  const upstream = new MemoryPeer()
  const proxy = new TransparentJsonRpcProxy(downstream, upstream, {
    sessionNonce: "nonce-1",
    requestTimeoutMs,
  })
  proxy.start()
  return { downstream, upstream, proxy }
}

describe("TransparentJsonRpcProxy", () => {
  it.each([
    [1, { result: { ok: true }, unknown: "kept" }],
    ["request-1", { error: { code: -32_000, message: "x", data: { kept: true } } }],
  ])("恢复 TUI 的原始 ID %s", (originalId, response) => {
    const test = setup()

    test.downstream.emitMessage({
      id: originalId,
      method: "unknown/method",
      params: { x: 1 },
    })
    const forwarded = test.upstream.sent.at(-1)!
    expect(String(forwarded.id)).toMatch(/^cqg-tui:nonce-1:/)
    expect(forwarded).toEqual({
      id: expect.any(String),
      method: "unknown/method",
      params: { x: 1 },
    })

    test.upstream.emitMessage({ id: forwarded.id, ...response })

    expect(test.downstream.sent.at(-1)).toEqual({ id: originalId, ...response })
    test.proxy.stop()
  })

  it("隔离 TUI、Guard 和 App Server 主动请求的相同 ID", async () => {
    const test = setup()
    test.downstream.emitMessage({ id: 1, method: "thread/read", params: { threadId: "t" } })
    const tuiForwarded = test.upstream.sent.at(-1)!
    const guardResult = test.proxy.request<{ ok: string }>("account/rateLimits/read")
    const guardForwarded = test.upstream.sent.at(-1)!

    expect(String(tuiForwarded.id)).toMatch(/^cqg-tui:nonce-1:/)
    expect(String(guardForwarded.id)).toMatch(/^cqg-guard:nonce-1:/)
    expect(tuiForwarded.id).not.toBe(guardForwarded.id)

    const serverRequest = {
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { decision: "required" },
      extensionField: "preserved",
    }
    test.upstream.emitMessage(serverRequest)
    expect(test.downstream.sent.at(-1)).toEqual(serverRequest)

    const serverResponse = {
      id: 1,
      result: { decision: "accept" },
      extensionField: "preserved",
    }
    test.downstream.emitMessage(serverResponse)
    expect(test.upstream.sent.at(-1)).toEqual(serverResponse)

    const downstreamCount = test.downstream.sent.length
    test.upstream.emitMessage({ id: guardForwarded.id, result: { ok: "guard" } })
    await expect(guardResult).resolves.toEqual({ ok: "guard" })
    expect(test.downstream.sent).toHaveLength(downstreamCount)

    test.upstream.emitMessage({ id: tuiForwarded.id, result: { ok: "tui" } })
    expect(test.downstream.sent.at(-1)).toEqual({ id: 1, result: { ok: "tui" } })
    test.proxy.stop()
  })

  it("双向透明保留未知通知、jsonrpc 和扩展字段", () => {
    const test = setup()
    const observedUpstream: JsonRpcMessage[] = []
    const observedTui: JsonRpcMessage[] = []
    test.proxy.on("notification", (message: JsonRpcMessage) => observedUpstream.push(message))
    test.proxy.on("tuiNotification", (message: JsonRpcMessage) => observedTui.push(message))
    const fromServer = {
      jsonrpc: "2.0",
      method: "future/serverNotification",
      params: { kept: true },
      extensionField: { future: true },
    }
    const fromTui = {
      jsonrpc: "2.0",
      method: "future/tuiNotification",
      extensionField: [1, 2, 3],
    }

    test.upstream.emitMessage(fromServer)
    test.downstream.emitMessage(fromTui)

    expect(test.downstream.sent.at(-1)).toEqual(fromServer)
    expect(test.upstream.sent.at(-1)).toEqual(fromTui)
    expect(observedUpstream).toEqual([fromServer])
    expect(observedTui).toEqual([fromTui])
    test.proxy.stop()
  })

  it("Guard 超时只拒绝自身等待且不伪造 TUI 响应", async () => {
    const test = setup(10)
    const downstreamCount = test.downstream.sent.length

    await expect(test.proxy.request("guard/neverResponds")).rejects.toThrow("请求超时")

    expect(test.downstream.sent).toHaveLength(downstreamCount)
    test.proxy.stop()
  })

  it("首个 turn/start 及后续上行消息按原顺序等待开门", () => {
    const test = setup()
    test.downstream.emitMessage({ id: 1, method: "initialize" })
    test.downstream.emitMessage({ id: 2, method: "turn/start", params: { x: 1 } })
    test.downstream.emitMessage({ method: "after/notification", params: { x: 2 } })
    test.downstream.emitMessage({ id: 3, method: "after/request", params: { x: 3 } })

    expect(test.upstream.sent.map((message) => message.method)).toEqual(["initialize"])

    test.proxy.openTurnGate()

    expect(test.upstream.sent.map((message) => message.method)).toEqual([
      "initialize",
      "turn/start",
      "after/notification",
      "after/request",
    ])
    test.proxy.stop()
  })

  it("停止时拒绝所有 Guard pending 并清除监听", async () => {
    const test = setup()
    const pending = test.proxy.request("guard/pending")

    test.proxy.stop(new Error("代理已断开"))

    await expect(pending).rejects.toThrow("代理已断开")
    const sentCount = test.upstream.sent.length
    test.downstream.emitMessage({ method: "after/stop" })
    expect(test.upstream.sent).toHaveLength(sentCount)
  })

  it("暂停 TUI 上行后仍允许 Guard 完成精确清理请求", async () => {
    const test = setup()

    test.proxy.pauseDownstream()
    test.downstream.emitMessage({ id: 1, method: "turn/start" })
    expect(test.upstream.sent).toHaveLength(0)

    const interrupt = test.proxy.request("turn/interrupt", {
      threadId: "thread-1",
      turnId: "turn-1",
    })
    const request = test.upstream.sent.at(-1)!
    test.upstream.emitMessage({ id: request.id, result: {} })

    await expect(interrupt).resolves.toEqual({})
    test.proxy.stop()
  })

  it("TUI 下游断开后保留上游供 Guard 清理直到会话显式停止", async () => {
    const test = setup()
    const disconnects: Error[] = []
    test.proxy.on("tuiDisconnect", (error: Error) => disconnects.push(error))

    test.downstream.emit("close")

    expect(disconnects).toHaveLength(1)
    expect(disconnects[0]?.message).toContain("TUI 已断开")
    test.downstream.emitMessage({ id: 1, method: "turn/start" })
    expect(test.upstream.sent).toHaveLength(0)

    const clean = test.proxy.request("thread/backgroundTerminals/clean", {
      threadId: "thread-1",
    })
    const request = test.upstream.sent.at(-1)!
    test.upstream.emitMessage({ id: request.id, result: {} })

    await expect(clean).resolves.toEqual({})
    test.proxy.stop()
  })
})
