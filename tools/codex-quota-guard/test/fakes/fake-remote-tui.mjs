import { appendFileSync } from "node:fs"
import WebSocket from "ws"

const args = process.argv.slice(2)
const scenario = process.env.CODEX_QUOTA_GUARD_FAKE_SCENARIO
const transcriptPath = process.env.CODEX_QUOTA_GUARD_FAKE_TRANSCRIPT
const remoteAddress = optionValue("--remote")
const tokenEnvironmentName = optionValue("--remote-auth-token-env")
const token = process.env[tokenEnvironmentName]

if (!transcriptPath || !remoteAddress || !token) {
  throw new Error("fake TUI 缺少 endpoint、token 或 transcript")
}

let nextId = 0
let finished = false
let secondStarted = false
let closeLogged = false
const pending = new Map()
const { url, options } = connectionOptions(remoteAddress, token)
const socket = new WebSocket(url, options)

socket.on("message", (data) => {
  const message = JSON.parse(data.toString())
  if (message.method && message.id !== undefined) {
    log({ event: "approval-received", method: message.method })
    socket.send(JSON.stringify({
      id: message.id,
      result: { decision: "fake-approval-decision" },
    }))
    return
  }
  if (message.id !== undefined) {
    const operation = pending.get(String(message.id))
    if (!operation) return
    pending.delete(String(message.id))
    if (message.error) operation.reject(new Error(message.error.message))
    else operation.resolve(message.result)
    return
  }
  if (message.method === "future/notification" && message.extensionField === "preserved") {
    log({ event: "unknown-preserved", method: message.method })
  }
  if (message.method === "turn/completed") {
    void handleTurnCompleted(message.params)
  }
})

socket.once("open", () => {
  log({ event: "tui-connected" })
  void startFlow().catch(fail)
})

socket.once("close", () => {
  logClosed()
  if (!finished) process.exitCode = 4
})

socket.once("error", (error) => fail(error))

process.once("SIGTERM", () => {
  logClosed()
  process.exit(0)
})

async function startFlow() {
  await request("initialize", {
    clientInfo: { name: "fake_tui", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  })
  notify("initialized")
  await request("thread/start", {
    experimentalRawEvents: false,
    persistExtendedHistory: false,
  })
  await request("turn/start", { threadId: "thread-1", input: [] })
}

async function handleTurnCompleted(params) {
  const turnId = params?.turn?.id
  const status = params?.turn?.status
  if (turnId === "turn-1" && scenario === "edge" && status === "interrupted") {
    if (secondStarted) return
    secondStarted = true
    await request("turn/start", { threadId: "thread-1", input: [] })
    return
  }
  if ((turnId === "turn-1" && scenario === "weekly-only") || turnId === "turn-2") {
    finished = true
    logClosed()
    socket.close(1000, "fake 完成")
  }
}

function request(method, params) {
  const id = `fake-tui-${++nextId}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

function notify(method, params) {
  socket.send(JSON.stringify(params === undefined ? { method } : { method, params }))
}

function optionValue(name) {
  const index = args.indexOf(name)
  return index === -1 ? "" : args[index + 1] ?? ""
}

function connectionOptions(address, capabilityToken) {
  const headers = { Authorization: `Bearer ${capabilityToken}` }
  if (address.startsWith("unix://")) {
    return {
      url: `ws+unix://${address.slice("unix://".length)}:/`,
      options: { headers },
    }
  }
  return { url: address, options: { headers } }
}

function log(entry) {
  appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`, "utf8")
}

function logClosed() {
  if (closeLogged) return
  closeLogged = true
  log({ event: "tui-closed" })
}

function fail(error) {
  const status = error instanceof Error
    ? `${error.name}:${error.message}:${error.cause?.code ?? error.code ?? ""}`
    : String(error)
  log({ event: "tui-error", status })
  process.exitCode = 5
  try {
    socket.close()
  } catch {
    process.exit(5)
  }
}
