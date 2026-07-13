import type {
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from "../src/app-server/protocol.js"

export function window(
  usedPercent: number,
  resetsAt: number,
  windowDurationMins = 300,
): RateLimitWindow {
  return { usedPercent, windowDurationMins, resetsAt }
}

export function snapshot(options: {
  limitId?: string
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
  credits?: RateLimitSnapshot["credits"]
} = {}): RateLimitSnapshot {
  return {
    limitId: options.limitId ?? "codex",
    limitName: null,
    primary: options.primary === undefined ? window(20, 2_000) : options.primary,
    secondary: options.secondary === undefined
      ? window(30, 8_000, 10_080)
      : options.secondary,
    credits: options.credits ?? null,
    planType: "plus",
    rateLimitReachedType: null,
  }
}

export function response(
  legacy: RateLimitSnapshot,
  buckets: Record<string, RateLimitSnapshot> | null = { codex: legacy },
): GetAccountRateLimitsResponse {
  return { rateLimits: legacy, rateLimitsByLimitId: buckets }
}
