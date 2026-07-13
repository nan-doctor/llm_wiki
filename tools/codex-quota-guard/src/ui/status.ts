import type { PersistedGuardState, TurnAdmission } from "../guard/state-machine.js"
import type { NormalizedWindow, QuotaSeverity } from "../quota/types.js"
import type { CapabilityMatrix } from "../runtime/capabilities.js"
import type { RuntimeContext } from "../runtime/runtime-context.js"
import type { RuntimeChange } from "../runtime/types.js"

export interface GuardStatusOutput {
  schemaVersion: 1
  observedAt: string | null
  stale: boolean
  protectedWindow: {
    available: boolean
    reason: "available" | "five-hour-window-unavailable" | "quota-data-unavailable" | "quota-data-stale"
    awaitingBaseline: boolean
  }
  quota: {
    source: "rateLimitsByLimitId.codex" | "rateLimits" | "persisted"
    limitId: string | null
    primary: NormalizedWindow | null
    secondary: NormalizedWindow | null
    protectedWindowSlot: "primary" | "secondary" | null
    protectedRemainingPercent: number | null
    overallRemainingPercent: number | null
    severity: QuotaSeverity
    credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null
  }
  guard: {
    state: "ARMED" | "HANDLING" | "HANDLED" | "DORMANT" | "UNKNOWN"
    windowKey: string | null
    thresholdHandled: boolean
    eventId: string | null
  }
  turns: TurnAdmission
  activeThreadId: string | null
  active: { threadId: string; turnId: string } | null
  limits: PersistedGuardState["limits"]
  executable: {
    codexExecutable: string
    codexExecutableRealPath: string | null
    codexVersion: string | null
    executableSelectionSource: RuntimeContext["executable"]["executableSelectionSource"]
  } | null
  protocolFingerprint: string | null
  capabilities: CapabilityMatrix | null
  goalControl: PersistedGuardState["goalControl"]
  runtimeChanges: RuntimeChange[]
}

export interface BuildStatusOptions {
  staleAfterMs?: number
  admission?: TurnAdmission
  runtimeContext?: RuntimeContext
}

export function buildStatusOutput(
  state: PersistedGuardState,
  now: number,
  options: BuildStatusOptions = {},
): GuardStatusOutput {
  const quota = state.quota
  const stale = !quota || now - quota.observedAt > (options.staleAfterMs ?? 90_000)
  const protectedWindowAvailable = !stale && quota?.protectedWindow !== null
  const protectedWindowReason = stale
    ? quota ? "quota-data-stale" as const : "quota-data-unavailable" as const
    : protectedWindowAvailable ? "available" as const : "five-hour-window-unavailable" as const
  const awaitingBaseline = protectedWindowAvailable
    && state.guard.state === "ARMED"
    && !state.guard.thresholdHandled
    && quota?.protectedRemainingPercent !== null
    && quota.protectedRemainingPercent <= 2
    && state.guard.lastProtectedRemainingPercent !== null
    && state.guard.lastProtectedRemainingPercent <= 2
  let turns = options.admission
  if (!turns) {
    turns = state.guard.state === "DORMANT" && !stale
      ? "ALLOWED"
      : stale || quota?.severity === "UNKNOWN"
      ? "BLOCKED"
      : state.guard.state === "HANDLING" ? "WAITING" : "ALLOWED"
  }

  return {
    schemaVersion: 1,
    observedAt: quota ? new Date(quota.observedAt).toISOString() : null,
    stale,
    protectedWindow: {
      available: protectedWindowAvailable,
      reason: protectedWindowReason,
      awaitingBaseline,
    },
    quota: {
      source: quota?.source ?? "persisted",
      limitId: quota?.limitId ?? null,
      primary: quota?.primary ?? null,
      secondary: quota?.secondary ?? null,
      protectedWindowSlot: quota?.protectedWindowSlot ?? null,
      protectedRemainingPercent: quota?.protectedRemainingPercent ?? null,
      overallRemainingPercent: quota?.overallRemainingPercent ?? null,
      severity: stale ? "UNKNOWN" : quota?.severity ?? "UNKNOWN",
      credits: quota?.credits ?? null,
    },
    guard: {
      state: state.guard.state,
      windowKey: state.guard.windowKey,
      thresholdHandled: state.guard.thresholdHandled,
      eventId: state.lastThresholdEvent?.id ?? null,
    },
    turns,
    activeThreadId: state.activeThreadId,
    active: state.activeTurn
      ? { threadId: state.activeTurn.threadId, turnId: state.activeTurn.turnId }
      : null,
    limits: { ...state.limits },
    executable: options.runtimeContext
      ? {
          codexExecutable: options.runtimeContext.executable.codexExecutable,
          codexExecutableRealPath: options.runtimeContext.executable.codexExecutableRealPath,
          codexVersion: options.runtimeContext.executable.codexVersion,
          executableSelectionSource: options.runtimeContext.executable.executableSelectionSource,
        }
      : null,
    protocolFingerprint: options.runtimeContext?.protocolFingerprint
      ?? state.runtime.current?.protocolFingerprint
      ?? null,
    capabilities: structuredClone(
      options.runtimeContext?.capabilityMatrix ?? state.runtime.capabilities,
    ),
    goalControl: state.goalControl,
    runtimeChanges: structuredClone(state.runtime.changes),
  }
}

export function formatStatusText(
  output: GuardStatusOutput,
  locale = "zh-CN",
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const lines = [
    ...orderedWindows(output).map(({ label, window }) => (
      formatWindow(label, window, locale, timeZone)
    )),
  ]
  const remaining = output.quota.protectedRemainingPercent === null
    ? "unknown left"
    : `${formatPercent(output.quota.protectedRemainingPercent)}% left`
  const overallRemaining = output.quota.overallRemainingPercent === null
    ? "unknown left"
    : `${formatPercent(output.quota.overallRemainingPercent)}% left`
  if (output.guard.state === "DORMANT" && !output.protectedWindow.available) {
    lines.push(`5h protection: UNAVAILABLE (${output.protectedWindow.reason})`)
    lines.push(`overall: ${overallRemaining} · guard: ${output.guard.state} · turns: ${output.turns}`)
  } else {
    lines.push(
      `quota: ${output.quota.severity} (${remaining}) · overall: ${overallRemaining} · guard: ${output.guard.state} · turns: ${output.turns}`,
    )
    if (!output.protectedWindow.available) {
      lines.push(`5h protection: UNAVAILABLE (${output.protectedWindow.reason})`)
    }
  }
  if (output.protectedWindow.awaitingBaseline) {
    lines.push("5h protection: AVAILABLE · awaiting baseline")
  }
  if (output.quota.credits) {
    const credits = output.quota.credits
    lines.push(
      `credits: hasCredits=${String(credits.hasCredits)} · unlimited=${String(credits.unlimited)} · balance=${credits.balance ?? "unknown"}`,
    )
  }
  if (output.stale) lines.push("quota data: STALE")
  return lines.join("\n")
}

function formatWindow(
  name: string,
  window: NormalizedWindow | null,
  locale: string,
  timeZone: string,
): string {
  if (!window) return `${name}: unknown used · unknown left · window unknown · resets unknown`
  const reset = window.resetsAt === null
    ? "unknown"
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "short",
        timeStyle: "medium",
        timeZone,
      }).format(new Date(window.resetsAt * 1_000))
  return [
    `${name}: ${formatPercent(window.usedPercent)}% used`,
    `${formatPercent(window.remainingPercent)}% left`,
    formatDuration(window.windowDurationMins),
    `resets ${reset}`,
  ].join(" · ")
}

function orderedWindows(output: GuardStatusOutput): Array<{
  label: string
  window: NormalizedWindow | null
}> {
  const windows = [output.quota.primary, output.quota.secondary]
  const ordered: Array<{ label: string; window: NormalizedWindow | null }> = windows
    .filter((window): window is NormalizedWindow => window !== null)
    .sort((left, right) => {
      if (left.windowDurationMins === 300) return -1
      if (right.windowDurationMins === 300) return 1
      return (left.windowDurationMins ?? Number.MAX_SAFE_INTEGER)
        - (right.windowDurationMins ?? Number.MAX_SAFE_INTEGER)
    })
    .map((window) => ({ label: windowLabel(window), window }))
  return ordered
}

function windowLabel(window: NormalizedWindow): string {
  if (window.windowDurationMins === 300) return "5h"
  if (window.windowDurationMins === 10_080) return "weekly"
  return `window ${window.windowDurationMins ?? "unknown"}m`
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return "window unknown"
  if (minutes === 10_080) return "weekly (7d, windowDurationMins=10080)"
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d (windowDurationMins=${minutes})`
  if (minutes % 60 === 0) return `${minutes / 60}h (windowDurationMins=${minutes})`
  return `${minutes}m (windowDurationMins=${minutes})`
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}
