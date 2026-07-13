import type { CreditsSnapshot } from "../app-server/protocol.js"

export type QuotaSeverity = "SAFE" | "WARNING" | "LOW" | "CRITICAL" | "UNKNOWN"
export type QuotaSource = "rateLimitsByLimitId.codex" | "rateLimits" | "persisted"

export interface NormalizedWindow {
  usedPercent: number
  remainingPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface NormalizedQuota {
  observedAt: number
  source: QuotaSource
  limitId: string | null
  primary: NormalizedWindow | null
  secondary: NormalizedWindow | null
  protectedWindowSlot: "primary" | "secondary" | null
  protectedWindow: NormalizedWindow | null
  protectedRemainingPercent: number | null
  overallRemainingPercent: number | null
  severity: QuotaSeverity
  credits: CreditsSnapshot | null
  windowKey: string | null
}
