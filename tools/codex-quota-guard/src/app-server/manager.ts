import { EventEmitter } from "node:events"
import type { AppServerConnection, ConnectionFactory } from "./connection.js"
import type { GetAccountRateLimitsResponse } from "./protocol.js"

export interface AppServerManagerOptions {
  reconnectDelaysMs?: number[]
  notificationRefreshDelayMs?: number
}

export class AppServerManager extends EventEmitter {
  currentRateLimits: GetAccountRateLimitsResponse | null = null
  private connection: AppServerConnection | null = null
  private stopped = true
  private reconnectPromise: Promise<void> | null = null
  private notificationRefresh: NodeJS.Timeout | null = null

  constructor(
    private readonly factory: ConnectionFactory,
    private readonly options: AppServerManagerOptions = {},
  ) {
    super()
  }

  async start(): Promise<void> {
    if (this.connection) return
    this.stopped = false
    await this.connectAndInitialize()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.notificationRefresh) clearTimeout(this.notificationRefresh)
    this.notificationRefresh = null
    const connection = this.connection
    this.connection = null
    if (connection) await connection.stop()
    if (this.reconnectPromise) await this.reconnectPromise.catch(() => undefined)
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureConnected()
    return await this.connection!.request<T>(method, params)
  }

  async refreshRateLimits(): Promise<GetAccountRateLimitsResponse> {
    const limits = await this.request<GetAccountRateLimitsResponse>("account/rateLimits/read")
    this.currentRateLimits = limits
    this.emit("rateLimits", limits)
    return limits
  }

  async waitForIdle(): Promise<void> {
    if (this.reconnectPromise) await this.reconnectPromise
  }

  private async connectAndInitialize(): Promise<void> {
    const connection = this.factory()
    this.connection = connection
    connection.on("notification", (message: { method: string; params?: unknown }) => {
      this.handleNotification(message)
    })
    connection.on("diagnostic", (message: string) => this.emit("diagnostic", message))
    connection.on("exit", (error: Error | null) => this.handleExit(connection, error))
    await connection.start()
    await connection.request("initialize", {
      clientInfo: {
        name: "codex_quota_guard",
        title: "Codex Quota Guard",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    })
    connection.sendNotification("initialized")
    await this.refreshRateLimits()
  }

  private handleNotification(message: { method: string; params?: unknown }): void {
    this.emit("notification", message)
    if (message.method !== "account/rateLimits/updated") return
    if (this.notificationRefresh) return
    this.notificationRefresh = setTimeout(() => {
      this.notificationRefresh = null
      void this.refreshRateLimits().catch((error: unknown) => {
        this.emit("diagnostic", error instanceof Error ? error.message : String(error))
      })
    }, this.options.notificationRefreshDelayMs ?? 25)
  }

  private handleExit(connection: AppServerConnection, error: Error | null): void {
    if (this.connection !== connection) return
    this.connection = null
    if (this.stopped) return
    if (error) this.emit("diagnostic", error.message)
    this.reconnectPromise = this.reconnect()
    void this.reconnectPromise.catch((reconnectError: unknown) => {
      this.emit("diagnostic", reconnectError instanceof Error
        ? reconnectError.message
        : String(reconnectError))
    })
  }

  private async reconnect(): Promise<void> {
    const delays = this.options.reconnectDelaysMs ?? [250, 500, 1_000, 2_000, 5_000, 10_000]
    let lastError: unknown = null
    for (let attempt = 0; !this.stopped; attempt += 1) {
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0
      if (delay > 0) await sleep(delay)
      try {
        await this.connectAndInitialize()
        this.reconnectPromise = null
        this.emit("reconnected")
        return
      } catch (error) {
        lastError = error
        this.connection = null
      }
    }
    if (lastError) throw lastError
  }

  private async ensureConnected(): Promise<void> {
    if (this.connection) return
    if (this.reconnectPromise) await this.reconnectPromise
    if (!this.connection) throw new Error("App Server 不可用")
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
