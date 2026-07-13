export interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number | null
  resetsAt: number | null
}

export interface CreditsSnapshot {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export interface RateLimitSnapshot {
  limitId?: string | null
  limitName?: string | null
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
  credits?: CreditsSnapshot | null
  planType?: string | null
  rateLimitReachedType?: string | null
}

export interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null
}

export interface ActiveTurn {
  threadId: string
  turnId: string
  startedAt: number
}

export type ThreadGoalStatus = "active" | "paused" | "budgetLimited" | "complete"

export interface ThreadGoal {
  threadId: string
  objective: string
  status: ThreadGoalStatus
  tokenBudget: number | null
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}

export interface JsonRpcRequest {
  method: string
  id: number
  params?: unknown
}

export interface JsonRpcServerRequest {
  method: string
  id: string | number
  params?: unknown
}

export interface JsonRpcNotification {
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export type AppServerMessage = JsonRpcNotification | JsonRpcResponse | JsonRpcServerRequest
