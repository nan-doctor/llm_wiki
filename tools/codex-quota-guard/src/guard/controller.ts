import type { GetAccountRateLimitsResponse, ThreadGoal } from "../app-server/protocol.js"
import { AppServerManager } from "../app-server/manager.js"
import { normalizeRateLimits } from "../quota/normalize.js"
import type { GuardStateRepository } from "../persistence/repository.js"
import type { ThresholdReporter } from "../report/reporter.js"
import {
  compareRuntimeIdentity,
  invalidateRuntimeEvidence,
  runtimeIdentityFromContext,
} from "../runtime/identity.js"
import type { RuntimeContext } from "../runtime/runtime-context.js"
import { AsyncMutex } from "./async-mutex.js"
import {
  applyQuotaObservation,
  applyStaleQuota,
  completeThresholdHandling,
  createInitialState,
  type PersistedGuardState,
  type TurnAdmission,
} from "./state-machine.js"

export interface GuardControllerOptions {
  now?: () => number
  staleAfterMs?: number
  unknownWaitMs?: number
  unknownRetryMs?: number
  runtimeContext?: RuntimeContext
}

export interface RunOptions {
  threadId?: string
  goal?: string
  tokenBudget?: number
  maxRuntimeMs?: number
  maxTurns?: number
  requireProtection?: boolean
}

export interface StartedTurn {
  threadId: string
  turnId: string
}

export class GuardController {
  private readonly mutex = new AsyncMutex()
  private readonly now: () => number
  private readonly staleAfterMs: number
  private readonly unknownWaitMs: number
  private readonly unknownRetryMs: number
  private readonly runtimeContext: RuntimeContext | null
  private state: PersistedGuardState = createInitialState()
  private readonly backgroundTasks = new Set<Promise<void>>()
  private readonly completedTurnStatuses = new Map<string, string>()
  private readonly turnWaiters = new Map<string, (status: string) => void>()
  private started = false

  constructor(
    private readonly manager: AppServerManager,
    private readonly repository: GuardStateRepository,
    private readonly reporter: ThresholdReporter,
    options: GuardControllerOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.staleAfterMs = options.staleAfterMs ?? 90_000
    this.unknownWaitMs = options.unknownWaitMs ?? 15_000
    this.unknownRetryMs = options.unknownRetryMs ?? 500
    this.runtimeContext = options.runtimeContext ?? null
  }

  async start(): Promise<void> {
    if (this.started) return
    this.state = await this.repository.load() ?? createInitialState()
    this.applyCurrentRuntimeContext()
    this.manager.on("rateLimits", this.onRateLimits)
    this.manager.on("notification", this.onNotification)
    this.manager.on("diagnostic", this.onDiagnostic)
    this.manager.on("reconnected", this.onReconnected)
    await this.manager.start()
    await this.waitForBackgroundTasks()
    await this.recoverInterruptedHandling()
    this.started = true
  }

  async stop(): Promise<void> {
    this.manager.off("rateLimits", this.onRateLimits)
    this.manager.off("notification", this.onNotification)
    this.manager.off("diagnostic", this.onDiagnostic)
    this.manager.off("reconnected", this.onReconnected)
    await this.waitForBackgroundTasks()
    await this.manager.stop()
    this.started = false
  }

  status(): { state: PersistedGuardState; admission: TurnAdmission } {
    const admission = this.state.guard.state === "DORMANT"
      ? "ALLOWED"
      : this.state.quota?.severity === "UNKNOWN"
      ? "WAITING"
      : this.state.guard.state === "HANDLING" ? "WAITING" : "ALLOWED"
    return { state: structuredClone(this.state), admission }
  }

  async refreshAndHandleQuota(): Promise<void> {
    try {
      await this.manager.refreshRateLimits()
    } catch (error) {
      let staleApplied = false
      await this.mutex.run(async () => {
        const transition = applyStaleQuota(
          this.state,
          this.state.activeTurn,
          this.now(),
          this.staleAfterMs,
        )
        staleApplied = transition.state.quota?.severity === "UNKNOWN"
        this.state = transition.state
        await this.repository.save(this.state)
        if (transition.event?.target) await this.handleThresholdEvent(transition.event.id)
        else if (transition.event) await this.reporter.write(this.state)
      })
      if (!staleApplied) throw error
    }
    await this.waitForBackgroundTasks()
  }

  async run(prompt: string, options: RunOptions = {}): Promise<StartedTurn> {
    assertPrompt(prompt)
    await this.refreshUntilKnown()
    return await this.mutex.run(async () => {
      this.applyRunLimits(options)
      this.assertTurnAdmission(options.requireProtection ?? false)
      const threadId = options.threadId
        ? await this.resumeThread(options.threadId)
        : await this.startThread()
      this.captureTaskRuntime()
      await this.repository.save(this.state)
      if (options.goal || options.tokenBudget !== undefined) {
        await this.manager.request("thread/goal/set", {
          threadId,
          objective: options.goal,
          tokenBudget: options.tokenBudget,
        })
      }
      return await this.startTurn(threadId, prompt)
    })
  }

  async resume(prompt?: string): Promise<StartedTurn | null> {
    await this.refreshUntilKnown()
    return await this.mutex.run(async () => {
      const event = this.state.lastThresholdEvent
      if (!event || !event.target || this.state.resumableEventId !== event.id) {
        throw new Error("没有可恢复的中断记录，请改用 run")
      }
      this.assertCoreProtectionCapabilities()
      this.assertTurnAdmission(this.state.limits.requireProtection)
      const threadId = await this.resumeThread(event.target.threadId)
      if (event.originalGoal) {
        await this.manager.request("thread/goal/set", {
          threadId,
          objective: event.originalGoal.objective,
          status: event.originalGoal.status,
          tokenBudget: event.originalGoal.tokenBudget,
        })
      }
      this.captureTaskRuntime()
      this.state.resumableEventId = null
      await this.repository.save(this.state)
      if (prompt === undefined || prompt.trim() === "") return null
      return await this.startTurn(threadId, prompt)
    })
  }

  async waitForTurn(
    started: StartedTurn,
    maxRuntimeMs?: number,
  ): Promise<string> {
    await this.waitForBackgroundTasks()
    const key = turnKey(started.threadId, started.turnId)
    const completedStatus = this.completedTurnStatuses.get(key)
    if (completedStatus !== undefined) {
      this.completedTurnStatuses.delete(key)
      return completedStatus
    }
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      let timeout: NodeJS.Timeout | null = null
      const finish = (status: string): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        this.turnWaiters.delete(key)
        this.completedTurnStatuses.delete(key)
        resolve(status)
      }
      this.turnWaiters.set(key, finish)
      if (maxRuntimeMs !== undefined) {
        timeout = setTimeout(() => {
          void this.manager.request("turn/interrupt", started)
            .then(() => finish("interrupted"))
            .catch((error: unknown) => {
              if (isIdempotentInterruptError(error)) finish("interrupted")
              else reject(error)
            })
        }, maxRuntimeMs)
        timeout.unref()
      }
    })
  }

  async waitForIdle(): Promise<void> {
    await this.waitForBackgroundTasks()
  }

  private readonly onRateLimits = (limits: GetAccountRateLimitsResponse): void => {
    this.queueBackground(this.handleRateLimits(limits))
  }

  private readonly onNotification = (message: { method: string; params?: unknown }): void => {
    if (message.method === "turn/completed") {
      this.queueBackground(this.handleTurnCompleted(message.params))
    } else if (message.method === "item/completed") {
      this.queueBackground(this.handleItemCompleted(message.params))
    } else if (message.method === "error") {
      this.queueBackground(this.handleError(message.params))
    }
  }

  private readonly onReconnected = (): void => {
    this.queueBackground(this.reconcileActiveTurn())
  }

  private readonly onDiagnostic = (message: string): void => {
    this.queueBackground(this.handleError(message))
  }

  private async handleRateLimits(limits: GetAccountRateLimitsResponse): Promise<void> {
    await this.mutex.run(async () => {
      const quota = normalizeRateLimits(limits, this.now())
      const transition = applyQuotaObservation(
        this.state,
        quota,
        this.state.activeTurn,
        this.now(),
      )
      this.state = transition.state
      await this.repository.save(this.state)
      if (!transition.event) return
      if (!transition.event.target) {
        await this.reporter.write(this.state)
        return
      }
      await this.handleThresholdEvent(transition.event.id)
    })
  }

  private async handleThresholdEvent(eventId: string): Promise<void> {
    const event = this.state.lastThresholdEvent
    if (!event || event.id !== eventId || !event.target) return
    const target = event.target

    event.interruptAttempted = true
    try {
      await this.manager.request("turn/interrupt", {
        threadId: target.threadId,
        turnId: target.turnId,
      })
      event.interruptSucceeded = true
    } catch (error) {
      if (isIdempotentInterruptError(error)) {
        event.interruptSucceeded = true
      } else {
        event.interruptSucceeded = false
        event.errors.push(errorMessage(error))
      }
    }

    try {
      const response = await this.manager.request<{ goal: ThreadGoal | null }>(
        "thread/goal/get",
        { threadId: target.threadId },
      )
      event.originalGoal = response.goal
      await this.repository.save(this.state)
      if (response.goal) {
        await this.manager.request("thread/goal/set", {
          threadId: target.threadId,
          status: "paused",
        })
        event.goalPaused = true
      }
    } catch (error) {
      event.goalPaused = false
      event.errors.push(errorMessage(error))
    }

    try {
      await this.manager.request("thread/backgroundTerminals/clean", {
        threadId: target.threadId,
      })
      event.backgroundTerminalsCleaned = true
    } catch (error) {
      event.backgroundTerminalsCleaned = false
      event.errors.push(errorMessage(error))
    }

    if (this.state.activeTurn?.threadId === target.threadId
      && this.state.activeTurn.turnId === target.turnId) {
      this.state.activeTurn = null
    }
    this.state = completeThresholdHandling(this.state, eventId, this.now())
    await this.reporter.write(this.state)
    await this.repository.save(this.state)
  }

  private async recoverInterruptedHandling(): Promise<void> {
    if (this.state.guard.state !== "HANDLING") return
    const eventId = this.state.lastThresholdEvent?.id
    if (!eventId) return
    await this.mutex.run(async () => this.handleThresholdEvent(eventId))
  }

  private async reconcileActiveTurn(): Promise<void> {
    await this.mutex.run(async () => {
      const activeTurn = this.state.activeTurn
      if (!activeTurn) return
      try {
        const response = await this.manager.request<{
          thread: { turns?: Array<{ id: string; status: string }> }
        }>("thread/resume", {
          threadId: activeTurn.threadId,
          excludeTurns: false,
          persistExtendedHistory: false,
        })
        const turn = response.thread.turns?.find((candidate) => candidate.id === activeTurn.turnId)
        if (turn && turn.status !== "inProgress") this.state.activeTurn = null
        await this.repository.save(this.state)
      } catch (error) {
        this.state.errors.push(`重连后 active turn 对账失败：${errorMessage(error)}`)
        await this.repository.save(this.state)
      }
    })
  }

  private async refreshUntilKnown(): Promise<void> {
    const deadline = Date.now() + this.unknownWaitMs
    while (true) {
      try {
        await this.refreshAndHandleQuota()
      } catch {
        // 连接错误与 UNKNOWN 使用同一个有限重试窗口。
      }
      if (this.state.guard.state === "DORMANT") return
      if (this.state.quota && this.state.quota.severity !== "UNKNOWN") return
      if (Date.now() >= deadline) {
        throw new Error("额度数据为 UNKNOWN，无法启动新 turn")
      }
      await sleep(Math.min(this.unknownRetryMs, Math.max(1, deadline - Date.now())))
    }
  }

  private assertTurnAdmission(requireProtection = false): void {
    if (requireProtection && this.state.guard.state === "DORMANT") {
      throw new Error("5 小时保护当前不可用；请等待 300 分钟窗口恢复或移除 --require-protection")
    }
    if (requireProtection && this.isAwaitingBaseline()) {
      throw new Error("5 小时保护仍在等待安全基线；请等待额度恢复到高于 5% 或移除 --require-protection")
    }
    if (!this.state.quota
      || (this.state.quota.severity === "UNKNOWN" && this.state.guard.state !== "DORMANT")) {
      throw new Error("额度数据为 UNKNOWN，无法启动新 turn")
    }
    if (this.state.guard.state === "HANDLING") {
      throw new Error("阈值事件仍在处理中，请稍后重试")
    }
    if (this.state.limits.maxTurns !== null
      && this.state.limits.turnsStarted >= this.state.limits.maxTurns) {
      throw new Error("已达到最大 turn 数量")
    }
  }

  private applyRunLimits(options: RunOptions): void {
    this.state.limits.requireProtection = options.requireProtection ?? false
    if (options.tokenBudget !== undefined) this.state.limits.goalTokenBudget = options.tokenBudget
    if (options.maxRuntimeMs !== undefined) this.state.limits.maxRuntimeMs = options.maxRuntimeMs
    if (options.maxTurns !== undefined) this.state.limits.maxTurns = options.maxTurns
  }

  private applyCurrentRuntimeContext(): void {
    if (!this.runtimeContext) return
    const current = runtimeIdentityFromContext(this.runtimeContext)
    const changes = compareRuntimeIdentity(this.state.runtime.task, current)
    this.state.runtime.current = current
    this.state.runtime.changes = changes
    this.state.runtime.capabilities = invalidateRuntimeEvidence(
      this.runtimeContext.capabilityMatrix,
      changes.length > 0,
    )
  }

  private captureTaskRuntime(): void {
    if (!this.state.runtime.current) return
    this.state.runtime.task = { ...this.state.runtime.current }
  }

  private assertCoreProtectionCapabilities(): void {
    if (!this.runtimeContext) return
    const required: Array<[keyof RuntimeContext["schemaCapabilities"], string]> = [
      ["rateLimitsRead", "account/rateLimits/read"],
      ["rateLimitsUpdated", "account/rateLimits/updated"],
      ["turnStart", "turn/start"],
      ["turnInterrupt", "turn/interrupt"],
      ["threadRead", "thread/read"],
    ]
    const missing = required.find(([key]) => !this.runtimeContext!.schemaCapabilities[key])
    if (missing) throw new Error(`核心保护能力不可用：${missing[1]}`)
  }

  private isAwaitingBaseline(): boolean {
    const remaining = this.state.quota?.protectedRemainingPercent
    return this.state.guard.state === "ARMED"
      && !this.state.guard.thresholdHandled
      && remaining !== null
      && remaining !== undefined
      && remaining <= 2
      && this.state.guard.lastProtectedRemainingPercent !== null
      && this.state.guard.lastProtectedRemainingPercent <= 2
  }

  private async startThread(): Promise<string> {
    const response = await this.manager.request<{ thread: { id: string } }>("thread/start", {
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
    return response.thread.id
  }

  private async resumeThread(threadId: string): Promise<string> {
    const response = await this.manager.request<{ thread: { id: string } }>("thread/resume", {
      threadId,
      excludeTurns: true,
      persistExtendedHistory: false,
    })
    return response.thread.id
  }

  private async startTurn(threadId: string, prompt: string): Promise<StartedTurn> {
    const response = await this.manager.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
    })
    const turnId = await this.resolveRuntimeTurnId(threadId, response.turn.id)
    const started = { threadId, turnId }
    this.state.activeTurn = { ...started, startedAt: this.now() }
    this.state.limits.turnsStarted += 1
    this.state.updatedAt = this.now()
    await this.repository.save(this.state)
    return started
  }

  private async resolveRuntimeTurnId(threadId: string, responseTurnId: string): Promise<string> {
    try {
      const response = await this.manager.request<{
        thread: { turns?: Array<{ id: string; status: string }> }
      }>("thread/read", {
        threadId,
        includeTurns: true,
      })
      const activeTurns = response.thread.turns?.filter((turn) => (
        turn.status === "inProgress"
      )) ?? []
      if (activeTurns.length === 1) return activeTurns[0].id
    } catch {
      // 兼容缺少 thread/read 或尚未物化 turn 的旧 App Server。
    }
    return responseTurnId
  }

  private async handleTurnCompleted(params: unknown): Promise<void> {
    await this.mutex.run(async () => {
      const value = params as {
        threadId?: string
        turn?: { id?: string; status?: string; error?: unknown }
      }
      if (typeof value.threadId === "string" && typeof value.turn?.id === "string") {
        const key = turnKey(value.threadId, value.turn.id)
        const status = value.turn.status ?? "completed"
        this.completedTurnStatuses.set(key, status)
        while (this.completedTurnStatuses.size > 100) {
          const oldest = this.completedTurnStatuses.keys().next().value as string | undefined
          if (oldest === undefined) break
          this.completedTurnStatuses.delete(oldest)
        }
        const waiter = this.turnWaiters.get(key)
        if (waiter) waiter(status)
      }
      const activeTurn = this.state.activeTurn
      if (activeTurn
        && activeTurn.threadId === value.threadId
        && activeTurn.turnId === value.turn?.id) {
        this.state.activeTurn = null
        if (value.turn.status === "failed" && value.turn.error !== undefined) {
          this.state.errors.push(`turn 失败：${turnErrorMessage(value.turn.error)}`)
          this.state.errors = this.state.errors.slice(-50)
        }
        this.state.updatedAt = this.now()
        await this.repository.save(this.state)
      }
    })
  }

  private async handleItemCompleted(params: unknown): Promise<void> {
    await this.mutex.run(async () => {
      const value = params as { threadId?: string; turnId?: string; item?: unknown }
      const activeTurn = this.state.activeTurn
      if (!activeTurn
        || value.threadId !== activeTurn.threadId
        || value.turnId !== activeTurn.turnId) return
      this.state.completedItems.push(summarizeItem(value.item))
      this.state.completedItems = this.state.completedItems.slice(-100)
      await this.repository.save(this.state)
    })
  }

  private async handleError(params: unknown): Promise<void> {
    await this.mutex.run(async () => {
      this.state.errors.push(errorMessage(params))
      this.state.errors = this.state.errors.slice(-50)
      await this.repository.save(this.state)
    })
  }

  private queueBackground(task: Promise<void>): void {
    this.backgroundTasks.add(task)
    void task.finally(() => this.backgroundTasks.delete(task))
  }

  private async waitForBackgroundTasks(): Promise<void> {
    while (this.backgroundTasks.size > 0) {
      await Promise.all([...this.backgroundTasks])
    }
    await this.mutex.idle()
  }
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`
}

function turnErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return errorMessage(error)
}

function assertPrompt(prompt: string): void {
  if (prompt.trim() === "") throw new Error("提示不能为空")
}

function summarizeItem(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") return { type: typeof item }
  const value = item as Record<string, unknown>
  return {
    id: typeof value.id === "string" ? value.id : null,
    type: typeof value.type === "string" ? value.type : "unknown",
    status: typeof value.status === "string" ? value.status : null,
  }
}

function isIdempotentInterruptError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return message.includes("not found")
    || message.includes("already")
    || message.includes("completed")
    || message.includes("interrupted")
    || message.includes("不存在")
    || message.includes("已结束")
    || message.includes("已中断")
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
