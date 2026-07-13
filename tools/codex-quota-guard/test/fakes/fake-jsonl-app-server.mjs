import { appendFileSync } from "node:fs"
import readline from "node:readline"

const scenario = process.env.CODEX_QUOTA_GUARD_FAKE_SCENARIO

if (scenario) runE2eServer(scenario)
else runLegacyServer()

function runLegacyServer() {
  process.stderr.write("Authorization: Bearer fake-secret token=fake-token cookie=fake-cookie\n")
  const lines = readline.createInterface({ input: process.stdin })
  send({
    method: "unknown/notification",
    params: { kept: true },
    extensionField: "preserved",
  })
  send({
    id: "server-request-1",
    method: "unknown/serverRequest",
    params: { approval: "required" },
    extensionField: "preserved",
  })
  lines.on("line", (line) => {
    const message = JSON.parse(line)
    if (message.method === "test/exit") process.exit(7)
    if (message.id === undefined) return
    send({
      id: message.id,
      result: {
        kept: message.params?.kept === true,
        args: process.argv.slice(2),
        remoteTokenVisible: Boolean(process.env.CODEX_QUOTA_GUARD_REMOTE_TOKEN),
      },
      extensionField: "preserved",
    })
  })
}

function runE2eServer(activeScenario) {
  const transcriptPath = process.env.CODEX_QUOTA_GUARD_FAKE_TRANSCRIPT
  if (!transcriptPath) throw new Error("fake App Server 缺少 transcript")
  const lines = readline.createInterface({ input: process.stdin })
  const turns = new Map()
  let turnCount = 0
  let critical = false
  log({ event: "app-server-start" })
  log({
    event: "remote-token-visible",
    status: String(Boolean(process.env.CODEX_QUOTA_GUARD_REMOTE_TOKEN)),
  })

  lines.on("line", (line) => {
    const message = JSON.parse(line)
    if (message.method) log({ event: "request", method: message.method })
    if (message.id === undefined) return
    if (!message.method) {
      if (String(message.id) === "approval-1") log({ event: "approval-round-trip" })
      return
    }
    handleRequest(message)
  })

  process.once("SIGTERM", () => {
    log({ event: "app-server-stop" })
    process.exit(0)
  })

  function handleRequest(message) {
    if (message.method === "initialize") {
      reply(message.id, { serverInfo: { name: "fake-app-server", version: "1.0.0" } })
      return
    }
    if (message.method === "account/rateLimits/read") {
      reply(message.id, rateLimits(activeScenario, critical))
      return
    }
    if (message.method === "thread/start") {
      reply(message.id, { thread: { id: "thread-1", turns: [] } })
      notify("thread/started", { thread: { id: "thread-1" } })
      return
    }
    if (message.method === "turn/start") {
      turnCount += 1
      const turnId = `turn-${turnCount}`
      turns.set(turnId, "inProgress")
      log({ event: "turn-start", method: message.method, threadId: "thread-1", turnId })
      reply(message.id, { turn: { id: turnId, status: "inProgress" } })
      notify("turn/started", {
        threadId: "thread-1",
        turn: { id: turnId, status: "inProgress" },
      })
      if (activeScenario === "app-server-crash") {
        setTimeout(() => {
          log({ event: "app-server-crash" })
          process.exit(23)
        }, 30)
      } else if (activeScenario === "weekly-only"
        && turnId === "turn-1"
        && process.env.CODEX_QUOTA_GUARD_FAKE_HOLD !== "1") {
        setTimeout(() => completeTurn(turnId, "completed"), 40)
      } else if (activeScenario === "edge" && turnId === "turn-1") {
        send({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-1", turnId },
          extensionField: "preserved",
        })
        notify("future/notification", { kept: true }, { extensionField: "preserved" })
        setTimeout(() => {
          critical = true
          notify("account/rateLimits/updated", { source: "fake-edge" })
          notify("account/rateLimits/updated", { source: "fake-edge-duplicate" })
        }, 50)
      } else if (turnId === "turn-2") {
        setTimeout(() => completeTurn(turnId, "completed"), 40)
      }
      return
    }
    if (message.method === "turn/interrupt") {
      const threadId = message.params?.threadId
      const turnId = message.params?.turnId
      log({ event: "interrupt", method: message.method, threadId, turnId })
      reply(message.id, {})
      if (turns.get(turnId) === "inProgress") completeTurn(turnId, "interrupted")
      return
    }
    if (message.method === "thread/read") {
      reply(message.id, {
        thread: {
          id: "thread-1",
          turns: [...turns].map(([id, status]) => ({ id, status })),
        },
      })
      return
    }
    if (message.method === "thread/resume") {
      reply(message.id, {
        thread: {
          id: "thread-1",
          turns: [...turns].map(([id, status]) => ({ id, status })),
        },
      })
      return
    }
    if (message.method === "thread/goal/get") {
      reply(message.id, { goal: null })
      return
    }
    if (message.method === "thread/goal/set"
      || message.method === "thread/backgroundTerminals/clean") {
      reply(message.id, {})
      return
    }
    reply(message.id, {})
  }

  function completeTurn(turnId, status) {
    if (turns.get(turnId) !== "inProgress") return
    turns.set(turnId, status)
    notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: turnId, status },
    })
  }

  function log(entry) {
    appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`, "utf8")
  }
}

function rateLimits(activeScenario, critical) {
  const weekly = {
    usedPercent: activeScenario === "weekly-only" ? 99 : 40,
    windowDurationMins: 10_080,
    resetsAt: 4_000_604_800,
  }
  const fiveHour = {
    usedPercent: critical ? 98.5 : 90,
    windowDurationMins: 300,
    resetsAt: 4_000_018_000,
  }
  const snapshot = {
    limitId: "codex",
    limitName: "Codex",
    primary: activeScenario === "weekly-only" ? weekly : fiveHour,
    secondary: activeScenario === "weekly-only" ? null : weekly,
    credits: null,
    planType: "plus",
    rateLimitReachedType: null,
  }
  return { rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot } }
}

function reply(id, result) {
  send({ id, result })
}

function notify(method, params, extra = {}) {
  send({ method, params, ...extra })
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
