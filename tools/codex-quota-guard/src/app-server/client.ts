import type { EventEmitter } from "node:events"
import type { GetAccountRateLimitsResponse } from "./protocol.js"

export interface GuardNotification {
  method: string
  params?: unknown
  sessionGeneration?: string
}

export interface GuardAppServerClient extends EventEmitter {
  currentRateLimits: GetAccountRateLimitsResponse | null
  start(): Promise<void>
  stop(): Promise<void>
  request<T>(method: string, params?: unknown): Promise<T>
  refreshRateLimits(): Promise<GetAccountRateLimitsResponse>
  waitForIdle(): Promise<void>
}
