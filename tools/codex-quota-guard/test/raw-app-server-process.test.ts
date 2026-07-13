import { once } from "node:events"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import type { JsonRpcMessage } from "../src/proxy/json-rpc.js"
import { RawAppServerProcess } from "../src/proxy/raw-app-server-process.js"

const fakeScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fakes/fake-jsonl-app-server.mjs",
)

function waitForMessage(
  transport: RawAppServerProcess,
  predicate: (message: JsonRpcMessage) => boolean,
): Promise<JsonRpcMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      transport.off("message", onMessage)
      reject(new Error("等待 fake App Server 消息超时"))
    }, 2_000)
    const onMessage = (message: JsonRpcMessage): void => {
      if (!predicate(message)) return
      clearTimeout(timeout)
      transport.off("message", onMessage)
      resolve(message)
    }
    transport.on("message", onMessage)
  })
}

describe("RawAppServerProcess", () => {
  it("完整保留未知 JSON-RPC 消息并安全构造 App Server 子进程", async () => {
    const transport = new RawAppServerProcess({
      codexPath: process.execPath,
      codexArgsPrefix: [fakeScript],
      enableGoals: true,
      environment: {
        ...process.env,
        CODEX_QUOTA_GUARD_REMOTE_TOKEN: "must-not-leak",
      },
    })
    const received: JsonRpcMessage[] = []
    const diagnostics: string[] = []
    transport.on("message", (message: JsonRpcMessage) => received.push(message))
    transport.on("diagnostic", (message: string) => diagnostics.push(message))

    await transport.start()
    const responsePromise = waitForMessage(transport, (message) => message.id === "tui-1")
    transport.send({
      id: "tui-1",
      method: "unknown/request",
      params: { kept: true },
    })
    const response = await responsePromise

    expect(response).toEqual({
      id: "tui-1",
      result: {
        kept: true,
        args: ["--enable", "goals", "app-server", "--listen", "stdio://"],
        remoteTokenVisible: false,
      },
      extensionField: "preserved",
    })
    expect(received).toContainEqual({
      method: "unknown/notification",
      params: { kept: true },
      extensionField: "preserved",
    })
    expect(received).toContainEqual({
      id: "server-request-1",
      method: "unknown/serverRequest",
      params: { approval: "required" },
      extensionField: "preserved",
    })
    expect(diagnostics.join("\n")).not.toContain("fake-secret")
    expect(diagnostics.join("\n")).not.toContain("fake-token")
    expect(diagnostics.join("\n")).not.toContain("fake-cookie")
    await transport.stop()
  })

  it("非主动退出只报告一次并拒绝继续写入", async () => {
    const transport = new RawAppServerProcess({
      codexPath: process.execPath,
      codexArgsPrefix: [fakeScript],
      enableGoals: false,
    })
    const exits: Array<Error | null> = []
    transport.on("exit", (error: Error | null) => exits.push(error))
    await transport.start()
    const exited = once(transport, "exit")

    transport.send({ method: "test/exit" })
    await exited

    expect(exits).toHaveLength(1)
    expect(exits[0]?.message).toContain("code=7")
    expect(() => transport.send({ method: "after/exit" })).toThrow("App Server 尚未启动")
    await transport.stop()
    expect(exits).toHaveLength(1)
  })
})
