import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { AppServerManager } from "../src/app-server/manager.js"
import { ProcessAppServerConnection } from "../src/app-server/process-connection.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("ProcessAppServerConnection", () => {
  it("跨平台启动含空格路径中的 fake App Server 子进程", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quota guard process "))
    roots.push(root)
    const script = path.join(root, "fake app server.mjs")
    await writeFile(script, `
import readline from "node:readline"
process.stderr.write("authorization: Basic secret-auth cookie=session-secret token=secret-token\\n")
const lines = readline.createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  const result = message.method === "account/rateLimits/read"
    ? {
        rateLimits: {
          limitId: "codex",
          limitName: process.argv.slice(2).join(" "),
          primary: null,
          secondary: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null
        },
        rateLimitsByLimitId: null
      }
    : {}
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n")
})
`, "utf8")
    const manager = new AppServerManager(
      () => new ProcessAppServerConnection({
        codexPath: process.execPath,
        codexArgsPrefix: [script],
        enableGoals: true,
        requestTimeoutMs: 2_000,
      }),
      { reconnectDelaysMs: [0] },
    )
    const diagnostics: string[] = []
    manager.on("diagnostic", (message: string) => diagnostics.push(message))

    await manager.start()

    expect(manager.currentRateLimits?.rateLimits.limitId).toBe("codex")
    expect(manager.currentRateLimits?.rateLimits.limitName).toContain("--enable goals")
    expect(diagnostics.join("\n")).not.toContain("secret-auth")
    expect(diagnostics.join("\n")).not.toContain("session-secret")
    expect(diagnostics.join("\n")).not.toContain("secret-token")
    await manager.stop()
  })

  it("明确拒绝不支持的服务器请求而不是把它误当成响应并挂起", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quota guard server request "))
    roots.push(root)
    const script = path.join(root, "fake bidirectional app server.mjs")
    await writeFile(script, `
import readline from "node:readline"
const lines = readline.createInterface({ input: process.stdin })
let initializeId = null
let serverRequestRejected = false
lines.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === "initialize") {
    initializeId = message.id
    process.stdout.write(JSON.stringify({
      id: "server-approval",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" }
    }) + "\\n")
    return
  }
  if (message.id === "server-approval") {
    serverRequestRejected = message.error?.code === -32601
    process.stdout.write(JSON.stringify({ id: initializeId, result: {} }) + "\\n")
    return
  }
  if (message.method === "account/rateLimits/read") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {
      rateLimits: {
        limitId: "codex",
        limitName: serverRequestRejected ? "server-request-rejected" : "server-request-lost",
        primary: null,
        secondary: null,
        credits: null,
        planType: null,
        rateLimitReachedType: null
      },
      rateLimitsByLimitId: null
    } }) + "\\n")
  }
})
`, "utf8")
    const manager = new AppServerManager(
      () => new ProcessAppServerConnection({
        codexPath: process.execPath,
        codexArgsPrefix: [script],
        requestTimeoutMs: 200,
      }),
      { reconnectDelaysMs: [0] },
    )

    await manager.start()

    expect(manager.currentRateLimits?.rateLimits.limitName).toBe("server-request-rejected")
    await manager.stop()
  })
})
