import { once } from "node:events"
import { stat } from "node:fs/promises"
import net from "node:net"
import WebSocket from "ws"
import { describe, expect, it } from "vitest"
import type { JsonRpcMessage } from "../src/proxy/json-rpc.js"
import { LocalTuiEndpoint } from "../src/proxy/local-tui-endpoint.js"

async function connect(address: string, token: string): Promise<WebSocket> {
  const options: WebSocket.ClientOptions = {
    headers: { Authorization: `Bearer ${token}` },
    handshakeTimeout: 1_000,
  }
  let url = address
  if (address.startsWith("unix://")) {
    const socketPath = address.slice("unix://".length)
    url = "ws://localhost/"
    options.createConnection = () => net.createConnection(socketPath)
  }
  const client = new WebSocket(url, options)
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
  it("Unix socket 使用受限权限、认证单客户端并完整清理", async () => {
    const endpoint = await LocalTuiEndpoint.create({
      platform: "darwin",
      token: "correct-secret",
      temporaryRoot: "/tmp",
    })
    const directory = endpoint.temporaryDirectory!
    const socketPath = endpoint.address.slice("unix://".length)

    expect(endpoint.address).toMatch(/^unix:\/\//)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600)
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
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" })
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
