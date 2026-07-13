import { EventEmitter } from "node:events"
import type {
  AppServerConnection,
  ConnectionFactory,
} from "../src/app-server/connection.js"

type Handler = (params: unknown) => unknown | Promise<unknown>

export class FakeAppServerConnection extends EventEmitter implements AppServerConnection {
  readonly requests: Array<{ method: string; params: unknown }> = []
  readonly notifications: Array<{ method: string; params: unknown }> = []
  private readonly handlers = new Map<string, Handler>()
  started = false
  stopped = false

  respond(method: string, handler: Handler | unknown): void {
    this.handlers.set(method, typeof handler === "function"
      ? handler as Handler
      : () => handler)
  }

  async start(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    const handler = this.handlers.get(method)
    if (!handler) throw new Error(`fake 未配置方法：${method}`)
    return await handler(params) as T
  }

  sendNotification(method: string, params?: unknown): void {
    this.notifications.push({ method, params })
  }

  emitNotification(method: string, params?: unknown): void {
    this.emit("notification", { method, params })
  }

  emitExit(error: Error | null = null): void {
    this.emit("exit", error)
  }
}

export class FakeConnectionFactory {
  readonly connections: FakeAppServerConnection[] = []

  constructor(private readonly configure: (connection: FakeAppServerConnection) => void) {}

  readonly create: ConnectionFactory = () => {
    const connection = new FakeAppServerConnection()
    this.configure(connection)
    this.connections.push(connection)
    return connection
  }
}
