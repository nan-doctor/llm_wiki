import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { appendFileSync } from "node:fs"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { GuardController } from "../src/guard/controller.js"
import { InteractiveSession } from "../src/interactive/session.js"
import { TuiProcess } from "../src/interactive/tui-process.js"
import { StateStore } from "../src/persistence/state-store.js"
import { InteractiveAppServerClient } from "../src/proxy/interactive-app-server-client.js"
import { LocalTuiEndpoint } from "../src/proxy/local-tui-endpoint.js"
import { RawAppServerProcess } from "../src/proxy/raw-app-server-process.js"
import { TransparentJsonRpcProxy } from "../src/proxy/transparent-proxy.js"
import { LocalThresholdReporter } from "../src/report/local-reporter.js"
import { buildCapabilityMatrix, emptyCapabilities } from "../src/runtime/capabilities.js"
import type { RuntimeContext } from "../src/runtime/runtime-context.js"

type Scenario = "edge" | "weekly-only" | "app-server-crash"

interface TranscriptEntry {
  event: string
  method?: string
  threadId?: string
  turnId?: string
  status?: string
}

interface E2eResult {
  exitCode: number
  state: NonNullable<Awaited<ReturnType<StateStore["load"]>>>
  transcript: TranscriptEntry[]
  publicContent: string
  endpointDirectory: string | null
}

class TrackedRawAppServerProcess extends RawAppServerProcess {
  constructor(
    options: ConstructorParameters<typeof RawAppServerProcess>[0],
    private readonly transcriptPath: string,
  ) {
    super(options)
  }

  override async stop(): Promise<void> {
    await super.stop()
    appendFileSync(
      this.transcriptPath,
      `${JSON.stringify({ event: "app-server-process-stopped" })}\n`,
      "utf8",
    )
  }
}

const roots: string[] = []
const fakeCodex = fileURLToPath(new URL("./fakes/fake-codex.mjs", import.meta.url))

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })))
})

describe("默认终端代理 fake 端到端", () => {
  it("只中断边沿瞬间的 first turn，HANDLED 后放行 second turn", async () => {
    const result = await runFakeInteractive("edge")

    expect(result.exitCode, JSON.stringify(result.transcript, null, 2)).toBe(0)
    expect(result.transcript.filter((entry) => entry.event === "interrupt"))
      .toEqual([{
        event: "interrupt",
        method: "turn/interrupt",
        threadId: "thread-1",
        turnId: "turn-1",
      }])
    expect(result.transcript
      .filter((entry) => entry.event === "turn-start")
      .map((entry) => entry.turnId)).toEqual(["turn-1", "turn-2"])
    expect(result.transcript.filter((entry) => entry.event === "approval-round-trip"))
      .toHaveLength(1)
  expect(result.transcript.some((entry) => entry.event === "unknown-preserved"))
      .toBe(true)
    expect(result.transcript).toContainEqual({
      event: "remote-token-visible",
      status: "false",
    })
    expect(result.state.guard).toMatchObject({
      state: "HANDLED",
      thresholdHandled: true,
    })
    expect(result.state.quota?.severity).toBe("CRITICAL")
    expect(result.state.lastThresholdEvent?.target).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
    })
    expect(result.state.activeTurn).toBeNull()
    expect(result.transcript.filter((entry) => (
      entry.method === "config/write"
      || entry.method === "config/value/write"
      || entry.method === "config/batchWrite"
    ))).toEqual([])
    expect(result.publicContent).not.toMatch(
      /FAKE_PROMPT|FAKE_MODEL_OUTPUT|fake-approval-decision|secret-capability-token-e2e/,
    )
    expect(JSON.stringify(result.transcript)).not.toContain("secret-capability-token-e2e")
    await expectPathMissing(result.endpointDirectory)
  })

  it("只有 weekly 时不触发中断并保持 DORMANT + ALLOWED 语义", async () => {
    const result = await runFakeInteractive("weekly-only")

    expect(result.exitCode, JSON.stringify(result.transcript, null, 2)).toBe(0)
    expect(result.transcript.filter((entry) => entry.event === "interrupt")).toEqual([])
    expect(result.state.guard.state).toBe("DORMANT")
    expect(result.state.quota?.protectedWindow).toBeNull()
    expect(result.state.quota?.primary?.windowDurationMins).toBe(10_080)
    expect(result.state.lastThresholdEvent).toBeNull()
    expect(result.transcript.some((entry) => (
      entry.method === "thread/backgroundTerminals/clean"
    ))).toBe(true)
    expect(result.state.errors.join("\n")).not.toContain("JSON-RPC 代理尚未启动")
    await expectPathMissing(result.endpointDirectory)
  })

  it("App Server 崩溃时关闭 TUI、保存错误且不重启上游", async () => {
    const result = await runFakeInteractive("app-server-crash")

    expect(result.exitCode).not.toBe(0)
    expect(result.transcript.filter((entry) => entry.event === "app-server-start"))
      .toHaveLength(1)
    expect(result.transcript.some((entry) => entry.event === "tui-process-exit"))
      .toBe(true)
    expect(result.state.errors.join("\n")).toContain("App Server")
    await expectPathMissing(result.endpointDirectory)
  })

  it("SIGINT 返回 130 并清理 TUI、App Server 与 loopback endpoint", async () => {
    const result = await runFakeInteractive("weekly-only", { signal: "SIGINT" })

    expect(result.exitCode).toBe(130)
    expect(result.transcript.some((entry) => entry.event === "tui-process-exit"))
      .toBe(true)
    expect(result.transcript.some((entry) => (
      entry.event === "app-server-process-stopped"
    ))).toBe(true)
    expect(result.transcript.some((entry) => (
      entry.method === "thread/backgroundTerminals/clean"
    ))).toBe(true)
    expect(result.state.activeTurn).toBeNull()
    await expectPathMissing(result.endpointDirectory)
  })
})

async function runFakeInteractive(
  scenario: Scenario,
  options: { signal?: "SIGINT" } = {},
): Promise<E2eResult> {
  const root = await mkdtemp(path.join(os.tmpdir(), `cqg-e2e-${scenario}-`))
  roots.push(root)
  const transcriptPath = path.join(root, "transcript.jsonl")
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_QUOTA_GUARD_FAKE_SCENARIO: scenario,
    CODEX_QUOTA_GUARD_FAKE_TRANSCRIPT: transcriptPath,
    CODEX_QUOTA_GUARD_REMOTE_TOKEN: "must-not-reach-app-server",
    CODEX_QUOTA_GUARD_FAKE_HOLD: options.signal ? "1" : "0",
  }
  const runtime = runtimeContext(fakeCodex)
  const stateStore = new StateStore(root)
  const reporter = new LocalThresholdReporter(root, {
    inspectGit: async () => "## fake-git\n M fake-file",
  })
  const raw = new TrackedRawAppServerProcess({
    codexPath: process.execPath,
    codexArgsPrefix: [fakeCodex],
    enableGoals: true,
    environment,
  }, transcriptPath)
  let endpointDirectory: string | null = null
  const generation = randomUUID()
  const signalSource = new EventEmitter()
  const session = new InteractiveSession({
    runPreflight: async () => undefined,
    raw,
    createToken: () => "secret-capability-token-e2e",
    createEndpoint: async (token) => {
      const endpoint = await LocalTuiEndpoint.create({
        platform: process.platform,
        token,
      })
      endpointDirectory = endpoint.temporaryDirectory
      return endpoint
    },
    createProxy: (endpoint) => new TransparentJsonRpcProxy(endpoint, raw, {
      sessionNonce: randomUUID(),
      requestTimeoutMs: 2_000,
    }),
    createController: (sessionProxy) => {
      const client = new InteractiveAppServerClient(
        sessionProxy as TransparentJsonRpcProxy,
        {
          sessionGeneration: generation,
          initializedTimeoutMs: 2_000,
          notificationRefreshDelayMs: 2,
        },
      )
      const controller = new GuardController(client, stateStore, reporter, {
        runtimeContext: runtime,
        interactiveSession: {
          generation,
          clearUnboundActiveTurnOnStart: true,
        },
      })
      return {
        start: async () => await controller.start(),
        waitUntilListening: async () => await client.waitUntilSubscribed(),
        shutdownInteractiveSession: async () => {
          await controller.shutdownInteractiveSession()
        },
        stop: async () => await controller.stop(),
      }
    },
    createTui: (options) => new TuiProcess(
      {
        executable: process.execPath,
        codexArgsPrefix: [fakeCodex],
        remoteAddress: options.remoteAddress,
        tokenEnvironmentName: options.tokenEnvironmentName,
        token: options.token,
        tuiArgs: options.tuiArgs,
        environment,
      },
      (executable, args, spawnOptions) => {
        const child = spawn(executable, args, spawnOptions)
        child.once("exit", (code, signal) => {
          appendFileSync(
            transcriptPath,
            `${JSON.stringify({
              event: "tui-process-exit",
              status: code === null ? signal ?? "unknown" : String(code),
            })}\n`,
            "utf8",
          )
        })
        return child
      },
    ),
    tokenEnvironmentName: "CODEX_QUOTA_GUARD_REMOTE_TOKEN",
    signalSource,
  })

  let exitCode: number
  try {
    const operation = session.run({ tuiArgs: [], requireProtection: false })
    if (options.signal) {
      await waitForTranscriptEvent(transcriptPath, "turn-start", 2_000)
      signalSource.emit(options.signal)
    }
    exitCode = await withTimeout(
      operation,
      8_000,
      `fake 交互场景超时：${scenario}`,
    )
  } finally {
    await session.stop("test-finally")
  }
  const state = await stateStore.load()
  if (!state) throw new Error("端到端场景未保存状态")
  const transcript = await readTranscript(transcriptPath)
  const publicContent = await readPublicGuardContent(root)
  return { exitCode, state, transcript, publicContent, endpointDirectory }
}

async function waitForTranscriptEvent(
  transcriptPath: string,
  event: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const transcript = await readTranscript(transcriptPath)
      if (transcript.some((entry) => entry.event === event)) return
    } catch {
      // fake 进程可能尚未创建 transcript。
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待 transcript 事件超时：${event}`)
}

function runtimeContext(codexPath: string): RuntimeContext {
  const capabilities = emptyCapabilities()
  capabilities.rateLimitsRead = true
  capabilities.rateLimitsUpdated = true
  capabilities.turnStart = true
  capabilities.turnInterrupt = true
  capabilities.threadRead = true
  capabilities.goalGet = true
  capabilities.goalSet = true
  capabilities.goalPaused = true
  capabilities.goalResume = true
  capabilities.backgroundTerminalsClean = true
  capabilities.serverRequestHandling = true
  return {
    executable: {
      codexExecutable: codexPath,
      codexExecutableRealPath: codexPath,
      codexVersion: "codex-cli fake-e2e",
      executableSelectionSource: "cli",
      launchAllowed: true,
      discoveredCandidates: [],
    },
    protocolFingerprint: "fake-e2e-fingerprint",
    schemaCapabilities: capabilities,
    capabilityMatrix: buildCapabilityMatrix(capabilities),
    remoteCapabilities: {
      remoteTui: true,
      remoteAuthTokenEnv: true,
      remoteUnixSocket: true,
      remoteLoopbackWebSocket: true,
      appServerStdio: true,
    },
  }
}

async function readTranscript(transcriptPath: string): Promise<TranscriptEntry[]> {
  const content = await readFile(transcriptPath, "utf8")
  return content.split("\n").filter(Boolean).map((line) => (
    JSON.parse(line) as TranscriptEntry
  ))
}

async function readPublicGuardContent(root: string): Promise<string> {
  const directory = path.join(root, ".codex-guard")
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const files = entries.filter((entry) => entry.isFile())
  return (await Promise.all(files.map(async (entry) => await readFile(
    path.join(entry.parentPath, entry.name),
    "utf8",
  )))).join("\n")
}

async function expectPathMissing(value: string | null): Promise<void> {
  if (!value) return
  await expect(stat(value)).rejects.toMatchObject({ code: "ENOENT" })
}

async function withTimeout<T>(
  operation: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
