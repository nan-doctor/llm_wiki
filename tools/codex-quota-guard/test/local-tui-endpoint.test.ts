import { once } from "node:events"
import WebSocket from "ws"
import { describe, expect, it } from "vitest"
import type { JsonRpcMessage } from "../src/proxy/json-rpc.js"
import { LocalTuiEndpoint } from "../src/proxy/local-tui-endpoint.js"

async function connect(address: string, token: string): Promise<WebSocket> {
  const options: WebSocket.ClientOptions = {
    headers: { Authorization: `Bearer ${token}` },
    handshakeTimeout: 1_000,
  }
  const client = new WebSocket(address, options)
  return await new Promise((resolve, reject) => {
    client.once("open", () => resolve(client))
    client.once("error", reject)
    client.once("unexpected-response", (_request, response) => {
      response.destroy()
      reject(new Error(`WebSocket Upgrade 被拒绝：${response.statusCode}`))
    })
  })
}

async function closeClient(client: WebSocket): Promise<void> {
  if (client.readyState === WebSocket.CLOSED) return
  const closed = once(client, "close")
  client.close()
  await closed
}

describe("LocalTuiEndpoint", () => {
  it.each(["darwin", "linux"] as const)(
    "%s 也使用带 token 的 loopback WebSocket",
    async (platform) => {
      const endpoint = await LocalTuiEndpoint.create({
        platform,
        token: "loopback-secret",
      })

      expect(endpoint.address).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
      expect(endpoint.address).not.toContain("loopback-secret")
      expect(endpoint.temporaryDirectory).toBeNull()
      await endpoint.stop()
    },
  )

  it("loopback endpoint 认证单客户端并透明传输消息", async () => {
    const endpoint = await LocalTuiEndpoint.create({
      platform: "darwin",
      token: "correct-secret",
    })

    expect(endpoint.address).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(endpoint.temporaryDirectory).toBeNull()
    await expect(connect(endpoint.address, "wrong-secret")).rejects.toThrow("401")

    const client = await connect(endpoint.address, "correct-secret")
    await expect(connect(endpoint.address, "correct-secret")).rejects.toThrow("409")
    const incoming = once(endpoint, "message")
    client.send(JSON.stringify({
      jsonrpc: "2.0",
      id: "tui-1",
      method: "unknown/method",
      extensionField: "preserved",
    }))
    await expect(incoming).resolves.toEqual([{
      jsonrpc: "2.0",
      id: "tui-1",
      method: "unknown/method",
      extensionField: "preserved",
    }])

    const outgoing = once(client, "message")
    endpoint.send({ id: "tui-1", result: { kept: true }, extensionField: "preserved" })
    const [payload] = await outgoing
    expect(JSON.parse(payload.toString()) as JsonRpcMessage).toEqual({
      id: "tui-1",
      result: { kept: true },
      extensionField: "preserved",
    })

    await closeClient(client)
    await endpoint.stop()
  })

  it("Windows 分支只监听 loopback 随机端口且 token 不进入地址", async () => {
    const endpoint = await LocalTuiEndpoint.create({
      platform: "win32",
      token: "tcp-secret",
    })

    expect(endpoint.address).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(endpoint.address).not.toContain("tcp-secret")
    expect(endpoint.temporaryDirectory).toBeNull()
    const client = await connect(endpoint.address, "tcp-secret")

    const closed = once(client, "close")
    await endpoint.closeClient(1000, "测试完成")
    await closed
    expect(client.readyState).toBe(WebSocket.CLOSED)
    await endpoint.stop()
  })
})
