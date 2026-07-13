import { EventEmitter } from "node:events"
import {
  hasId,
  hasMethod,
  withId,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./json-rpc.js"

export interface JsonRpcPeer extends EventEmitter {
  send(message: JsonRpcMessage): void
}

export interface TransparentProxyOptions {
  sessionNonce: string
  requestTimeoutMs?: number
}

interface TuiRequestMapping {
  originalId: JsonRpcId
  method: string
}

interface GuardPending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export class TransparentJsonRpcProxy extends EventEmitter {
  private readonly tuiRequests = new Map<string, TuiRequestMapping>()
  private readonly guardPending = new Map<string, GuardPending>()
  private readonly turnQueue: JsonRpcMessage[] = []
  private tuiRequestCounter = 0
  private guardRequestCounter = 0
  private turnGateOpen = false
  private downstreamPaused = false
  private started = false

  constructor(
    private readonly downstream: JsonRpcPeer,
    private readonly upstream: JsonRpcPeer,
    private readonly options: TransparentProxyOptions,
  ) {
    super()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.downstreamPaused = false
    this.downstream.on("message", this.onDownstreamMessage)
    this.upstream.on("message", this.onUpstreamMessage)
    this.downstream.on("close", this.onDownstreamClose)
    this.upstream.on("exit", this.onUpstreamExit)
  }

  stop(error = new Error("JSON-RPC 代理已停止")): void {
    if (!this.started) return
    this.started = false
    this.downstream.off("message", this.onDownstreamMessage)
    this.upstream.off("message", this.onUpstreamMessage)
    this.downstream.off("close", this.onDownstreamClose)
    this.upstream.off("exit", this.onUpstreamExit)
    this.tuiRequests.clear()
    this.turnQueue.splice(0)
    for (const pending of this.guardPending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.guardPending.clear()
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.started) return Promise.reject(new Error("JSON-RPC 代理尚未启动"))
    const id = `cqg-guard:${this.options.sessionNonce}:${++this.guardRequestCounter}`
    const timeoutMs = this.options.requestTimeoutMs ?? 15_000
    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.guardPending.delete(id)
        reject(new Error(`Guard 请求超时：${method}`))
      }, timeoutMs)
      timeout.unref()
      this.guardPending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })
    })
    try {
      this.upstream.send(params === undefined ? { id, method } : { id, method, params })
    } catch (error) {
      const pending = this.guardPending.get(id)
      if (pending) {
        clearTimeout(pending.timeout)
        this.guardPending.delete(id)
        pending.reject(asError(error))
      }
    }
    return promise
  }

  pauseDownstream(): void {
    this.downstreamPaused = true
    this.turnQueue.splice(0)
  }

  openTurnGate(): void {
    if (this.turnGateOpen) return
    this.turnGateOpen = true
    for (const message of this.turnQueue.splice(0)) this.forwardTuiMessage(message)
  }

  private readonly onDownstreamMessage = (message: JsonRpcMessage): void => {
    if (this.downstreamPaused) return
    if (hasMethod(message)) {
      this.emitObservation(hasId(message) ? "tuiRequest" : "tuiNotification", message)
    } else {
      this.emitObservation("tuiResponse", message)
    }
    this.forwardOrQueue(message)
  }

  private readonly onUpstreamMessage = (message: JsonRpcMessage): void => {
    if (hasMethod(message)) {
      this.emitObservation(hasId(message) ? "serverRequest" : "notification", message)
      if (!this.downstreamPaused) this.downstream.send(message)
      return
    }
    if (!hasId(message) || typeof message.id !== "string") {
      if (!this.downstreamPaused) this.downstream.send(message)
      return
    }

    const pending = this.guardPending.get(message.id)
    if (pending) {
      this.guardPending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    const mapping = this.tuiRequests.get(message.id)
    if (mapping) {
      this.tuiRequests.delete(message.id)
      if (!this.downstreamPaused) this.downstream.send(withId(message, mapping.originalId))
      return
    }

    if (this.isOwnedId(message.id)) return
    if (!this.downstreamPaused) this.downstream.send(message)
  }

  private readonly onDownstreamClose = (): void => {
    const error = new Error("TUI 已断开")
    this.emitEvent("exit", error)
    this.stop(error)
  }

  private readonly onUpstreamExit = (error: Error | null): void => {
    const reason = error ?? new Error("App Server 已断开")
    this.emitEvent("exit", reason)
    this.stop(reason)
  }

  private forwardOrQueue(message: JsonRpcMessage): void {
    if (!this.turnGateOpen && (this.turnQueue.length > 0 || message.method === "turn/start")) {
      this.turnQueue.push(message)
      return
    }
    this.forwardTuiMessage(message)
  }

  private forwardTuiMessage(message: JsonRpcMessage): void {
    if (!hasMethod(message) || !hasId(message)) {
      this.upstream.send(message)
      return
    }
    const id = `cqg-tui:${this.options.sessionNonce}:${++this.tuiRequestCounter}`
    this.tuiRequests.set(id, {
      originalId: message.id ?? null,
      method: message.method!,
    })
    this.upstream.send(withId(message, id))
  }

  private isOwnedId(id: string): boolean {
    return id.startsWith(`cqg-guard:${this.options.sessionNonce}:`)
      || id.startsWith(`cqg-tui:${this.options.sessionNonce}:`)
  }

  private emitObservation(type: string, message: JsonRpcMessage): void {
    this.emitEvent(type, structuredClone(message))
  }

  private emitEvent(type: string, detail: unknown): void {
    this.emit(type, detail)
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
