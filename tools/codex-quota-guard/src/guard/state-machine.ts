import type { ActiveTurn, ThreadGoal } from "../app-server/protocol.js"
import type { NormalizedQuota } from "../quota/types.js"
import type { CapabilityMatrix } from "../runtime/capabilities.js"
import type { RuntimeChange, RuntimeIdentity } from "../runtime/types.js"

export type GuardPhase = "ARMED" | "HANDLING" | "HANDLED" | "DORMANT" | "UNKNOWN"
export type TurnAdmission = "ALLOWED" | "WAITING" | "BLOCKED"

export interface QuotaThresholdEvent {
  id: string
  occurredAt: number
  reason: "quota_threshold" | "stale_low_quota"
  windowKey: string
  target: ActiveTurn | null
  handlingCompletedAt: number | null
  interruptAttempted: boolean
  interruptSucceeded: boolean | null
  backgroundTerminalsCleaned: boolean | null
  originalGoal: ThreadGoal | null
  goalPaused: boolean | null
  errors: string[]
}

export interface GuardState {
  state: GuardPhase
  windowKey: string | null
  thresholdHandled: boolean
  lastProtectedRemainingPercent: number | null
}

export interface PersistedGuardState {
  schemaVersion: 1
  updatedAt: number
  quota: NormalizedQuota | null
  guard: GuardState
  activeTurn: ActiveTurn | null
  lastThresholdEvent: QuotaThresholdEvent | null
  resumableEventId: string | null
  limits: {
    goalTokenBudget: number | null
    maxRuntimeMs: number | null
    maxTurns: number | null
    turnsStarted: number
    requireProtection: boolean
  }
  runtime: {
    task: RuntimeIdentity | null
    current: RuntimeIdentity | null
    capabilities: CapabilityMatrix | null
    changes: RuntimeChange[]
  }
  completedItems: Array<Record<string, unknown>>
  errors: string[]
}

export interface GuardTransition {
  state: PersistedGuardState
  event: QuotaThresholdEvent | null
  admission: TurnAdmission
}

export function createInitialState(): PersistedGuardState {
  return {
    schemaVersion: 1,
    updatedAt: 0,
    quota: null,
    guard: {
      state: "UNKNOWN",
      windowKey: null,
      thresholdHandled: false,
      lastProtectedRemainingPercent: null,
    },
    activeTurn: null,
    lastThresholdEvent: null,
    resumableEventId: null,
    limits: {
      goalTokenBudget: null,
      maxRuntimeMs: null,
      maxTurns: null,
      turnsStarted: 0,
      requireProtection: false,
    },
    runtime: {
      task: null,
      current: null,
      capabilities: null,
      changes: [],
    },
    completedItems: [],
    errors: [],
  }
}

export function applyQuotaObservation(
  current: PersistedGuardState,
  quota: NormalizedQuota,
  activeTurn: ActiveTurn | null,
  now: number,
): GuardTransition {
  const state = structuredClone(current)
  state.updatedAt = now
  state.quota = quota
  state.activeTurn = activeTurn

  if (quota.windowKey === null) {
    if (state.guard.state !== "HANDLING") state.guard.state = "DORMANT"
    return {
      state,
      event: null,
      admission: state.guard.state === "HANDLING" ? "WAITING" : "ALLOWED",
    }
  }

  if (state.guard.state === "HANDLING") {
    state.guard.lastProtectedRemainingPercent = quota.protectedRemainingPercent
    return { state, event: null, admission: "WAITING" }
  }

  const previousRemaining = state.guard.lastProtectedRemainingPercent
  if (state.guard.state === "DORMANT") {
    const sameWindow = state.guard.windowKey === quota.windowKey
    if (sameWindow && state.guard.thresholdHandled) {
      if (quota.protectedRemainingPercent !== null
        && quota.protectedRemainingPercent > 5) {
        state.guard = {
          state: "ARMED",
          windowKey: quota.windowKey,
          thresholdHandled: false,
          lastProtectedRemainingPercent: quota.protectedRemainingPercent,
        }
      } else {
        state.guard.state = "HANDLED"
        state.guard.lastProtectedRemainingPercent = quota.protectedRemainingPercent
      }
      return { state, event: null, admission: "ALLOWED" }
    }
    if (!sameWindow) {
      state.guard = {
        state: "ARMED",
        windowKey: quota.windowKey,
        thresholdHandled: false,
        lastProtectedRemainingPercent: quota.protectedRemainingPercent,
      }
      return { state, event: null, admission: "ALLOWED" }
    }
    state.guard.state = "ARMED"
  }

  const windowChanged = state.guard.windowKey !== null
    && state.guard.windowKey !== quota.windowKey
  const firstKnownWindow = state.guard.windowKey === null
  const recoveredAboveFive = quota.protectedRemainingPercent !== null
    && quota.protectedRemainingPercent > 5
    && state.guard.thresholdHandled

  if (windowChanged || firstKnownWindow || recoveredAboveFive) {
    state.guard = {
      state: "ARMED",
      windowKey: quota.windowKey,
      thresholdHandled: false,
      lastProtectedRemainingPercent: quota.protectedRemainingPercent,
    }
    return { state, event: null, admission: "ALLOWED" }
  } else {
    state.guard.windowKey = quota.windowKey
  }

  const critical = quota.protectedRemainingPercent !== null
    && quota.protectedRemainingPercent <= 2
  const canTrigger = critical
    && state.guard.state === "ARMED"
    && !state.guard.thresholdHandled
    && previousRemaining !== null
    && previousRemaining > 2

  state.guard.lastProtectedRemainingPercent = quota.protectedRemainingPercent

  if (!canTrigger) {
    return {
      state,
      event: null,
      admission: "ALLOWED",
    }
  }

  const event: QuotaThresholdEvent = {
    id: `quota-${now}-${activeTurn?.turnId ?? "idle"}`,
    occurredAt: now,
    reason: "quota_threshold",
    windowKey: quota.windowKey,
    target: activeTurn ? { ...activeTurn } : null,
    handlingCompletedAt: activeTurn ? null : now,
    interruptAttempted: false,
    interruptSucceeded: null,
    backgroundTerminalsCleaned: null,
    originalGoal: null,
    goalPaused: null,
    errors: [],
  }

  state.guard.thresholdHandled = true
  state.guard.state = activeTurn ? "HANDLING" : "HANDLED"
  state.lastThresholdEvent = event
  state.resumableEventId = activeTurn ? event.id : null

  return {
    state,
    event,
    admission: activeTurn ? "WAITING" : "ALLOWED",
  }
}

export function completeThresholdHandling(
  current: PersistedGuardState,
  eventId: string,
  now: number,
): PersistedGuardState {
  const state = structuredClone(current)
  if (state.lastThresholdEvent?.id !== eventId) return state
  state.guard.state = "HANDLED"
  state.guard.thresholdHandled = true
  state.lastThresholdEvent.handlingCompletedAt = now
  state.updatedAt = now
  return state
}


export function applyStaleQuota(
  current: PersistedGuardState,
  activeTurn: ActiveTurn | null,
  now: number,
  staleAfterMs: number,
): GuardTransition {
  const state = structuredClone(current)
  const quota = state.quota
  if (!quota || now - quota.observedAt <= staleAfterMs) {
    return {
      state,
      event: null,
      admission: state.guard.state === "HANDLING" ? "WAITING" : "ALLOWED",
    }
  }

  quota.severity = "UNKNOWN"
  state.updatedAt = now
  state.activeTurn = activeTurn
  const windowKey = quota.windowKey
  const shouldHandle = quota.protectedRemainingPercent !== null
    && quota.protectedRemainingPercent <= 2
    && windowKey !== null
    && state.guard.state === "ARMED"
    && !state.guard.thresholdHandled

  if (!shouldHandle) return { state, event: null, admission: "BLOCKED" }

  const event: QuotaThresholdEvent = {
    id: `quota-stale-${now}-${activeTurn?.turnId ?? "idle"}`,
    occurredAt: now,
    reason: "stale_low_quota",
    windowKey: windowKey!,
    target: activeTurn ? { ...activeTurn } : null,
    handlingCompletedAt: activeTurn ? null : now,
    interruptAttempted: false,
    interruptSucceeded: null,
    backgroundTerminalsCleaned: null,
    originalGoal: null,
    goalPaused: null,
    errors: [],
  }
  state.guard.thresholdHandled = true
  state.guard.state = activeTurn ? "HANDLING" : "HANDLED"
  state.lastThresholdEvent = event
  state.resumableEventId = activeTurn ? event.id : null
  return {
    state,
    event,
    admission: activeTurn ? "WAITING" : "BLOCKED",
  }
}
