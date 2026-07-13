import type {
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from "../app-server/protocol.js"
import type {
  NormalizedQuota,
  NormalizedWindow,
  QuotaSeverity,
} from "./types.js"

export function normalizeRateLimits(
  response: GetAccountRateLimitsResponse,
  observedAt: number,
): NormalizedQuota {
  const codex = response.rateLimitsByLimitId?.codex
  const selected = codex ?? response.rateLimits
  const source = codex ? "rateLimitsByLimitId.codex" : "rateLimits"
  return normalizeSnapshot(selected, source, observedAt)
}

export function normalizeSnapshot(
  snapshot: RateLimitSnapshot,
  source: NormalizedQuota["source"],
  observedAt: number,
): NormalizedQuota {
  const primary = normalizeWindow(snapshot.primary)
  const secondary = normalizeWindow(snapshot.secondary)
  const validWindows = [primary, secondary].filter(
    (window): window is NormalizedWindow => window !== null,
  )
  const overallRemainingPercent = validWindows.length > 0
    ? Math.min(...validWindows.map((window) => window.remainingPercent))
    : null
  const protectedCandidates = [
    primary ? { slot: "primary" as const, window: primary } : null,
    secondary ? { slot: "secondary" as const, window: secondary } : null,
  ].filter((candidate): candidate is {
    slot: "primary" | "secondary"
    window: NormalizedWindow
  } => candidate !== null
    && candidate.window.windowDurationMins === 300
    && candidate.window.resetsAt !== null)
  const protectedCandidate = protectedCandidates.length === 1
    ? protectedCandidates[0]
    : null
  const protectedWindow = protectedCandidate?.window ?? null
  const protectedRemainingPercent = protectedWindow?.remainingPercent ?? null

  return {
    observedAt,
    source,
    limitId: snapshot.limitId ?? null,
    primary,
    secondary,
    protectedWindowSlot: protectedCandidate?.slot ?? null,
    protectedWindow,
    protectedRemainingPercent,
    overallRemainingPercent,
    severity: severityFor(protectedRemainingPercent),
    credits: snapshot.credits ?? null,
    windowKey: protectedWindow
      ? [snapshot.limitId ?? "unknown", 300, protectedWindow.resetsAt].join(":")
      : null,
  }
}

export function severityFor(remaining: number | null): QuotaSeverity {
  if (remaining === null || !Number.isFinite(remaining)) return "UNKNOWN"
  if (remaining <= 2) return "CRITICAL"
  if (remaining <= 3) return "LOW"
  if (remaining <= 5) return "WARNING"
  return "SAFE"
}

function normalizeWindow(window: RateLimitWindow | null | undefined): NormalizedWindow | null {
  if (!window || !Number.isFinite(window.usedPercent)) return null
  if (window.usedPercent < 0 || window.usedPercent > 100) return null
  if (window.windowDurationMins !== null && !Number.isFinite(window.windowDurationMins)) {
    return null
  }
  if (window.resetsAt !== null && !Number.isFinite(window.resetsAt)) return null

  return {
    usedPercent: window.usedPercent,
    remainingPercent: roundPercent(100 - window.usedPercent),
    windowDurationMins: window.windowDurationMins,
    resetsAt: window.resetsAt,
  }
}

function roundPercent(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
