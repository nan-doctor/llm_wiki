import { EventEmitter } from "node:events"
import type {
  GuardAppServerClient,
  GuardNotification,
} from "../app-server/client.js"
import type { GetAccountRateLimitsResponse } from "../app-server/protocol.js"
import { sanitizeDiagnostic } from "../persistence/state-store.js"
import type { JsonRpcMessage } from "./json-rpc.js"

export interface InteractiveProxy extends EventEmitter {
  request<T>(method: string, params?: unknown): Promise<T>
  openTurnGate(): void
}

export interface InteractiveAppServerClientOptions {
  sessionGeneration: string
  initializedTimeoutMs?: number
  notificationRefreshDelayMs?: number
}

export class InteractiveAppServerClient extends EventEmitter
  implements GuardAppServerClient {
  currentRateLimits: GetAccountRateLimitsResponse | null = null
  private started = false
  private stopped = true
  private startPromise: Promise<void> | null = null
  private initializedTimeout: NodeJS.Timeout | null = null
  private resolveInitialized: (() => void) | null = null
  private rejectInitialized: ((error: Error) => void) | null = null
  private notificationRefreshTimer: NodeJS.Timeout | null = null
  private notificationRefreshTask: Promise<void> | null = null
  private finishNotificationRefresh: (() => void) | null = null
  private subscribed = false
  private subscriptionConfirmed = false
  private readonly subscribedPromise: Promise<void>
  private readonly confirmSubscription: () => void

  constructor(
    private readonly proxy: InteractiveProxy,
    private readonly options: InteractiveAppServerClientOptions,
  ) {
    super()
    let confirmSubscription!: () => void
    this.subscribedPromise = new Promise((resolve) => {
      confirmSubscription = resolve
    })
    this.confirmSubscription = confirmSubscription
  }

  async start(): Promise<void> {
    if (this.started) return
    if (this.startPromise) return await this.startPromise
    this.stopped = false
    const operation = this.startInternal()
    this.startPromise = operation
    try {
      await operation
      this.started = true
    } finally {
      if (this.startPromise === operation) this.startPromise = null
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.started = false
    this.rejectInitializedWait(new Error("交互额度客户端已停止"))
    if (this.notificationRefreshTimer) {
      clearTimeout(this.notificationRefreshTimer)
      this.notificationRefreshTimer = null
      this.finishNotificationRefresh?.()
      this.finishNotificationRefresh = null
      this.notificationRefreshTask = null
    }
    this.unsubscribe()
    await this.waitForIdle()
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    return await this.proxy.request<T>(method, params)
  }

  async refreshRateLimits(): Promise<GetAccountRateLimitsResponse> {
    const limits = await this.request<GetAccountRateLimitsResponse>("account/rateLimits/read")
    this.currentRateLimits = limits
    this.emit("rateLimits", limits)
    return limits
  }

  async waitForIdle(): Promise<void> {
    while (this.notificationRefreshTask) await this.notificationRefreshTask
  }

  async waitUntilSubscribed(): Promise<void> {
    await this.subscribedPromise
  }

  private async startInternal(): Promise<void> {
    this.subscribe()
    try {
      await this.waitForInitialized()
      await this.refreshRateLimits()
      if (this.stopped) throw new Error("交互额度客户端已停止")
      this.proxy.openTurnGate()
    } catch (error) {
      this.unsubscribe()
      throw error
    }
  }

  private waitForInitialized(): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (): void => {
        if (this.initializedTimeout) clearTimeout(this.initializedTimeout)
        this.initializedTimeout = null
        this.resolveInitialized = null
        this.rejectInitialized = null
      }
      this.resolveInitialized = () => {
        finish()
        resolve()
      }
      this.rejectInitialized = (error) => {
        finish()
        reject(error)
      }
      this.initializedTimeout = setTimeout(() => {
        this.rejectInitializedWait(new Error("等待 TUI initialized 超时"))
      }, this.options.initializedTimeoutMs ?? 15_000)
      this.initializedTimeout.unref()
    })
  }

  private subscribe(): void {
    if (this.subscribed) return
    this.subscribed = true
    this.proxy.on("tuiNotification", this.onTuiNotification)
    this.proxy.on("notification", this.onNotification)
    this.proxy.on("exit", this.onProxyExit)
    if (!this.subscriptionConfirmed) {
      this.subscriptionConfirmed = true
      this.confirmSubscription()
    }
  }

  private unsubscribe(): void {
    if (!this.subscribed) return
    this.subscribed = false
    this.proxy.off("tuiNotification", this.onTuiNotification)
    this.proxy.off("notification", this.onNotification)
    this.proxy.off("exit", this.onProxyExit)
  }

  private readonly onTuiNotification = (message: JsonRpcMessage): void => {
    if (message.method === "initialized") this.resolveInitialized?.()
  }

  private readonly onNotification = (message: JsonRpcMessage): void => {
    if (typeof message.method !== "string") return
    this.emit("notification", {
      method: message.method,
      params: message.params,
      sessionGeneration: this.options.sessionGeneration,
    } satisfies GuardNotification)
    if (message.method === "account/rateLimits/updated") this.scheduleRateLimitsRefresh()
  }

  private readonly onProxyExit = (error: Error | null): void => {
    const reason = error ?? new Error("交互代理已断开")
    this.rejectInitializedWait(reason)
    this.emit("exit", reason)
  }

  private rejectInitializedWait(error: Error): void {
    this.rejectInitialized?.(error)
  }

  private scheduleRateLimitsRefresh(): void {
    if (this.stopped || this.notificationRefreshTask) return
    this.notificationRefreshTask = new Promise((resolve) => {
      this.finishNotificationRefresh = resolve
    })
    this.notificationRefreshTimer = setTimeout(() => {
      this.notificationRefreshTimer = null
      void this.refreshRateLimits()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          this.emit("diagnostic", sanitizeDiagnostic(message))
        })
        .finally(() => {
          this.finishNotificationRefresh?.()
          this.finishNotificationRefresh = null
          this.notificationRefreshTask = null
        })
    }, this.options.notificationRefreshDelayMs ?? 25)
    this.notificationRefreshTimer.unref()
  }
}
