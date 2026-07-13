import type { EventEmitter } from "node:events"

export interface AppServerConnection extends EventEmitter {
  start(): Promise<void>
  stop(): Promise<void>
  request<T>(method: string, params?: unknown): Promise<T>
  sendNotification(method: string, params?: unknown): void
}

export type ConnectionFactory = () => AppServerConnection
