import { AppServerManager } from "./app-server/manager.js"
import { ProcessAppServerConnection } from "./app-server/process-connection.js"
import { normalizeRateLimits } from "./quota/normalize.js"
import type { ThreadGoal } from "./app-server/protocol.js"
import {
  buildCapabilityMatrix,
  type CapabilityMatrix,
  type ProtocolCapabilities,
} from "./runtime/capabilities.js"
import type { RuntimeContext } from "./runtime/runtime-context.js"
import type { RemoteCapabilities } from "./runtime/remote-capabilities.js"
import {
  createAuditRecord,
  finalizeLatencies,
  observeAuditPoint,
  type AuditClock,
  type AuditMonotonicPoints,
  type AuditPoint,
  type EventAudit,
} from "./audit/timing.js"

export { buildCapabilityMatrix, inspectGeneratedProtocol } from "./runtime/capabilities.js"
export type { CapabilityMatrix, ProtocolCapabilities } from "./runtime/capabilities.js"

export interface LiveCanaryResult {
  attempted: true
  threadId: string | null
  turnId: string | null
  succeeded: boolean
  errors: string[]
  audit: EventAudit
}

export interface RunDoctorOptions {
  liveCanary?: boolean
}

export interface LiveCanaryExecution {
  result: LiveCanaryResult
  runtime: Partial<Record<keyof ProtocolCapabilities, boolean>>
}

export interface LiveCanaryOptions {
  clock?: AuditClock
}

interface DoctorRequestClient {
  request<T>(method: string, params?: unknown): Promise<T>
  on(
    event: "notification",
    listener: (message: { method: string; params?: unknown }) => void,
  ): unknown
  off(
    event: "notification",
    listener: (message: { method: string; params?: unknown }) => void,
  ): unknown
}

const TURN_STARTED_TIMEOUT_MS = 15_000

export interface DoctorResult {
  ok: boolean
  status: "ok" | "degraded" | "failed"
  codexExecutable: string
  executableRealPath: string | null
  executableSelectionSource: RuntimeContext["executable"]["executableSelectionSource"]
  codexVersion: string | null
  protocolFingerprint: string | null
  appServerHandshake: boolean
  rateLimitsRead: boolean
  fiveHourProtectionAvailable: boolean
  protocol: {
    versionStatus: "tested" | "unknown" | "unavailable"
    compatibilityBasis: "generated-schema" | "unavailable"
    requiredCapabilitiesPresent: boolean
  }
  capabilities: ProtocolCapabilities
  capabilityMatrix: CapabilityMatrix
  remoteCapabilities: RemoteCapabilities
  liveCanary: LiveCanaryResult | null
  warnings: string[]
  errors: string[]
}

export async function runDoctor(
  context: RuntimeContext,
  options: RunDoctorOptions = {},
): Promise<DoctorResult> {
  const warnings: string[] = []
  const errors: string[] = []
  const codexVersion = context.executable.codexVersion
  const capabilities = context.schemaCapabilities
  let appServerHandshake = false
  let rateLimitsRead = false
  let fiveHourProtectionAvailable = false
  let canary: LiveCanaryExecution | null = null

  if (!capabilities.goalPaused) {
    warnings.push("当前协议不支持 Goal paused；保护器不会清除 Goal，将记录降级")
  }
  if (!capabilities.backgroundTerminalsClean) {
    warnings.push("当前协议不支持 thread/backgroundTerminals/clean；后台 terminal 清理将降级")
  }

  const codexPath = context.executable.codexExecutableRealPath
  if (!codexPath) {
    errors.push("已解析的 Codex 没有可启动的真实路径")
  } else {
    const manager = new AppServerManager(
      () => new ProcessAppServerConnection({ codexPath, enableGoals: true }),
      { reconnectDelaysMs: [250, 500, 1_000] },
    )
    try {
      await manager.start()
      appServerHandshake = true
      rateLimitsRead = manager.currentRateLimits !== null
      if (manager.currentRateLimits) {
        fiveHourProtectionAvailable = normalizeRateLimits(
          manager.currentRateLimits,
          Date.now(),
        ).protectedWindow !== null
      }
      if (options.liveCanary) {
        const canarySchemaAvailable = capabilities.turnStart
          && capabilities.turnInterrupt
          && capabilities.goalGet
          && capabilities.goalSet
          && capabilities.goalPaused
          && capabilities.backgroundTerminalsClean
        if (!canarySchemaAvailable) {
          errors.push("live canary 所需协议能力不完整，未调用 turn/start")
        } else {
          canary = await runLiveCanary(manager)
          if (!canary.result.succeeded) {
            errors.push(`live canary 失败：${canary.result.errors.join("；")}`)
          }
        }
      }
    } catch (error) {
      errors.push(`App Server 握手或额度读取失败：${errorMessage(error)}`)
    } finally {
      await manager.stop()
    }
  }

  const hardCapabilities = capabilities.rateLimitsRead
    && capabilities.rateLimitsUpdated
    && capabilities.turnStart
    && capabilities.turnInterrupt
    && capabilities.threadRead
  const versionAssessment = assessCodexVersion(
    codexVersion,
    context.protocolFingerprint !== null,
  )
  if (versionAssessment.warning) warnings.push(versionAssessment.warning)
  if (rateLimitsRead && !fiveHourProtectionAvailable) {
    warnings.push("five-hour protection unavailable：当前额度快照未返回唯一有效的 300 分钟窗口")
  }
  const status = classifyDoctorStatus({
    hardCapabilities,
    appServerHandshake,
    rateLimitsRead,
    fiveHourProtectionAvailable,
    errors,
    warnings,
  })
  return {
    ok: status !== "failed",
    status,
    codexExecutable: context.executable.codexExecutable,
    executableRealPath: context.executable.codexExecutableRealPath,
    executableSelectionSource: context.executable.executableSelectionSource,
    codexVersion,
    protocolFingerprint: context.protocolFingerprint,
    appServerHandshake,
    rateLimitsRead,
    fiveHourProtectionAvailable,
    protocol: {
      versionStatus: versionAssessment.versionStatus,
      compatibilityBasis: versionAssessment.compatibilityBasis,
      requiredCapabilitiesPresent: hardCapabilities,
    },
    capabilities,
    capabilityMatrix: buildCapabilityMatrix(capabilities, {
      rateLimitsRead,
      ...canary?.runtime,
    }),
    remoteCapabilities: { ...context.remoteCapabilities },
    liveCanary: canary?.result ?? null,
    warnings,
    errors,
  }
}

export async function runLiveCanary(
  client: DoctorRequestClient,
  options: LiveCanaryOptions = {},
): Promise<LiveCanaryExecution> {
  const runtime: Partial<Record<keyof ProtocolCapabilities, boolean>> = {}
  const errors: string[] = []
  const audit = createAuditRecord("liveCanary")
  const auditPoints: AuditMonotonicPoints = {}
  const clock = options.clock ?? systemAuditClock()
  const observe = (point: AuditPoint): void => observeAuditPoint(
    audit,
    point,
    clock.utcNow(),
    clock.monotonicNow(),
    auditPoints,
  )
  observe("thresholdDetected")
  let threadId: string | null = null
  let turnId: string | null = null
  let originalGoal: ThreadGoal | null = null
  let goalRestored = false
  let terminalsCleaned = false
  const terminalListener = (message: { method: string; params?: unknown }): void => {
    if (message.method !== "turn/completed" || !turnId) return
    const params = message.params as {
      threadId?: unknown
      turn?: { id?: unknown; status?: unknown }
    } | undefined
    if (params?.threadId !== threadId || params.turn?.id !== turnId) return
    if (params.turn.status === "inProgress") return
    observe("turnTerminalStateObserved")
  }
  client.on("notification", terminalListener)

  try {
    const threadResponse = await client.request<{ thread: { id: string } }>("thread/start", {
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
    threadId = threadResponse.thread.id

    runtime.goalSet = false
    await client.request("thread/goal/set", {
      threadId,
      objective: "Codex Quota Guard live canary",
      status: "active",
      tokenBudget: 128,
    })
    runtime.goalSet = true

    runtime.goalGet = false
    const goalResponse = await client.request<{ goal: ThreadGoal | null }>(
      "thread/goal/get",
      { threadId },
    )
    runtime.goalGet = true
    originalGoal = goalResponse.goal
    if (!originalGoal) throw new Error("live canary 未读取到 Goal")

    runtime.goalPaused = false
    observe("goalPauseRequested")
    await client.request("thread/goal/set", { threadId, status: "paused" })
    runtime.goalSet = true
    const pausedResponse = await client.request<{ goal: ThreadGoal | null }>(
      "thread/goal/get",
      { threadId },
    )
    runtime.goalGet = true
    if (pausedResponse.goal?.status !== "paused") {
      runtime.goalPaused = false
      throw new Error("Goal paused 运行时验证失败")
    }
    runtime.goalPaused = true
    observe("goalPauseAcknowledged")

    await restoreGoal(client, threadId, originalGoal)
    goalRestored = true

    runtime.turnStart = false
    runtime.turnInterrupt = false
    const interruptedTurn = await startAndInterruptCanaryTurn(client, threadId, {
      activeTurnResolved: (startedId) => {
        turnId = startedId
        observe("activeTurnResolved")
      },
      interruptRequested: () => observe("interruptRequested"),
      interruptAcknowledged: () => observe("interruptAcknowledged"),
    })
    turnId = interruptedTurn
    runtime.turnStart = true
    runtime.turnInterrupt = true
    if (audit.turnTerminalStateObservedAt === null) {
      await reconcileCanaryTerminalState(client, threadId, turnId, runtime, () => {
        observe("turnTerminalStateObserved")
      })
    }

    runtime.backgroundTerminalsClean = false
    await client.request("thread/backgroundTerminals/clean", { threadId })
    runtime.backgroundTerminalsClean = true
    terminalsCleaned = true
    observe("backgroundTerminalCleaned")
  } catch (error) {
    errors.push(errorMessage(error))
  } finally {
    if (threadId && originalGoal && !goalRestored) {
      try {
        await restoreGoal(client, threadId, originalGoal)
        goalRestored = true
      } catch (error) {
        errors.push(`Goal 恢复失败：${errorMessage(error)}`)
      }
    }
    if (threadId && !terminalsCleaned) {
      try {
        await client.request("thread/backgroundTerminals/clean", { threadId })
        runtime.backgroundTerminalsClean = true
      } catch (error) {
        errors.push(`后台 terminal 清理失败：${errorMessage(error)}`)
      }
    }
    client.off("notification", terminalListener)
  }

  const succeeded = runtime.turnStart === true
    && runtime.turnInterrupt === true
    && runtime.goalGet === true
    && runtime.goalSet === true
    && runtime.goalPaused === true
    && runtime.backgroundTerminalsClean === true
    && goalRestored
    && errors.length === 0
  return {
    result: {
      attempted: true,
      threadId,
      turnId,
      succeeded,
      errors,
      audit: { ...audit, latencies: finalizeLatencies(audit, auditPoints) },
    },
    runtime,
  }
}

async function reconcileCanaryTerminalState(
  client: DoctorRequestClient,
  threadId: string,
  turnId: string,
  runtime: Partial<Record<keyof ProtocolCapabilities, boolean>>,
  observed: () => void,
): Promise<void> {
  try {
    const response = await client.request<{
      thread: { turns?: Array<{ id: string; status: string }> }
    }>("thread/read", { threadId, includeTurns: true })
    runtime.threadRead = true
    const turn = response.thread.turns?.find((candidate) => candidate.id === turnId)
    if (turn && turn.status !== "inProgress") observed()
  } catch {
    runtime.threadRead = false
  }
}

interface CanaryTurnHooks {
  activeTurnResolved(turnId: string): void
  interruptRequested(): void
  interruptAcknowledged(): void
}

async function startAndInterruptCanaryTurn(
  client: DoctorRequestClient,
  threadId: string,
  hooks: CanaryTurnHooks,
): Promise<string> {
  type InterruptOutcome = { ok: true } | { ok: false; error: unknown }
  type StartedTurn = { turnId: string; interrupt: Promise<InterruptOutcome> }
  let timeout: NodeJS.Timeout | null = null
  let settled = false
  let resolveStarted!: (value: StartedTurn) => void
  let rejectStarted!: (error: Error) => void
  const started = new Promise<StartedTurn>((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })
  const interruptTurn = (startedTurnId: string): Promise<InterruptOutcome> => (
    (hooks.interruptRequested(), client.request("turn/interrupt", {
      threadId,
      turnId: startedTurnId,
    })).then(
      (): InterruptOutcome => {
        hooks.interruptAcknowledged()
        return { ok: true }
      },
      (error: unknown): InterruptOutcome => ({ ok: false, error }),
    )
  )
  const listener = (message: { method: string; params?: unknown }): void => {
    if (settled || message.method !== "turn/started") return
    const params = message.params as { threadId?: unknown; turn?: { id?: unknown } } | undefined
    if (params?.threadId !== threadId || typeof params.turn?.id !== "string") return
    settled = true
    const startedTurnId = params.turn.id
    hooks.activeTurnResolved(startedTurnId)
    const interrupt = interruptTurn(startedTurnId)
    resolveStarted({ turnId: startedTurnId, interrupt })
  }

  client.on("notification", listener)
  timeout = setTimeout(() => {
    if (settled) return
    void client.request<{
      thread: { turns?: Array<{ id: string; status: string }> }
    }>("thread/read", {
      threadId,
      includeTurns: true,
    }).then((response) => {
      if (settled) return
      const activeTurns = response.thread.turns?.filter((turn) => (
        turn.status === "inProgress"
      )) ?? []
      if (activeTurns.length !== 1) {
        settled = true
        rejectStarted(new Error(
          "等待 turn/started 通知超时，thread/read 未唯一确认 inProgress turn，未中断",
        ))
        return
      }
      settled = true
      const startedTurnId = activeTurns[0].id
      hooks.activeTurnResolved(startedTurnId)
      resolveStarted({
        turnId: startedTurnId,
        interrupt: interruptTurn(startedTurnId),
      })
    }).catch((error: unknown) => {
      if (settled) return
      settled = true
      rejectStarted(new Error(
        `等待 turn/started 通知超时，thread/read 对账失败，未中断：${errorMessage(error)}`,
      ))
    })
  }, TURN_STARTED_TIMEOUT_MS)

  try {
    const turnResponsePromise = client.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: "请执行 shell 命令 sleep 30，然后只回复 OK" }],
    })
    const [, startedTurn] = await Promise.all([turnResponsePromise, started])
    const interrupt = await startedTurn.interrupt
    if (!interrupt.ok) throw interrupt.error
    return startedTurn.turnId
  } finally {
    if (timeout) clearTimeout(timeout)
    client.off("notification", listener)
  }
}

async function restoreGoal(
  client: DoctorRequestClient,
  threadId: string,
  goal: ThreadGoal,
): Promise<void> {
  await client.request("thread/goal/set", {
    threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
  })
}

export function assessCodexVersion(
  codexVersion: string | null,
  schemaGenerated: boolean,
): {
  versionStatus: "tested" | "unknown" | "unavailable"
  compatibilityBasis: "generated-schema" | "unavailable"
  warning: string | null
} {
  const compatibilityBasis = schemaGenerated ? "generated-schema" : "unavailable"
  if (codexVersion === null) {
    return { versionStatus: "unavailable", compatibilityBasis, warning: null }
  }
  if (codexVersion === "codex-cli 0.131.0") {
    return { versionStatus: "tested", compatibilityBasis, warning: null }
  }
  return {
    versionStatus: "unknown",
    compatibilityBasis,
    warning: `Codex 版本 ${codexVersion} 未经过本工具认证；能力结论仅来自当前生成的 schema`,
  }
}

export function classifyDoctorStatus(input: {
  hardCapabilities: boolean
  appServerHandshake: boolean
  rateLimitsRead: boolean
  fiveHourProtectionAvailable: boolean
  errors: string[]
  warnings: string[]
}): "ok" | "degraded" | "failed" {
  if (input.errors.length > 0
    || !input.hardCapabilities
    || !input.appServerHandshake
    || !input.rateLimitsRead) {
    return "failed"
  }
  if (!input.fiveHourProtectionAvailable || input.warnings.length > 0) return "degraded"
  return "ok"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function systemAuditClock(): AuditClock {
  return {
    utcNow: () => new Date().toISOString(),
    monotonicNow: () => performance.now(),
  }
}
