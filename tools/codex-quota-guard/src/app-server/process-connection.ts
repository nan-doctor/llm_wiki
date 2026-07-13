import { EventEmitter } from "node:events"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import readline from "node:readline"
import type { AppServerConnection } from "./connection.js"
import type {
  AppServerMessage,
  JsonRpcResponse,
  JsonRpcServerRequest,
} from "./protocol.js"

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export interface ProcessConnectionOptions {
  codexPath?: string
  codexArgsPrefix?: string[]
  enableGoals?: boolean
  requestTimeoutMs?: number
}

export class ProcessAppServerConnection extends EventEmitter implements AppServerConnection {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stopping = false

  constructor(private readonly options: ProcessConnectionOptions = {}) {
    super()
  }

  async start(): Promise<void> {
    if (this.child) return
    this.stopping = false
    const child = spawn(this.options.codexPath ?? "codex", [
      ...this.options.codexArgsPrefix ?? [],
      ...this.options.enableGoals ? ["--enable", "goals"] : [],
      "app-server",
      "--listen",
      "stdio://",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.child = child

    const lines = readline.createInterface({ input: child.stdout })
    lines.on("line", (line) => this.handleLine(line))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      this.emit("diagnostic", redactDiagnostic(chunk))
    })
    child.on("error", (error) => this.handleExit(error))
    child.on("exit", (code, signal) => {
      const error = this.stopping
        ? null
        : new Error(`App Server 已退出：code=${String(code)} signal=${String(signal)}`)
      this.handleExit(error)
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null
    if (child && !child.killed) child.kill("SIGTERM")
    this.rejectPending(new Error("App Server 连接已关闭"))
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const child = this.requireChild()
    const id = this.nextRequestId++
    const timeoutMs = this.options.requestTimeoutMs ?? 15_000
    const promise = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`App Server 请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })
    })
    child.stdin.write(`${JSON.stringify({ method, id, params })}\n`)
    return promise
  }

  sendNotification(method: string, params?: unknown): void {
    const child = this.requireChild()
    const message = params === undefined ? { method } : { method, params }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private requireChild(): ChildProcessWithoutNullStreams {
    if (!this.child) throw new Error("App Server 尚未启动")
    return this.child
  }

  private handleLine(line: string): void {
    let message: AppServerMessage
    try {
      message = JSON.parse(line) as AppServerMessage
    } catch {
      this.emit("diagnostic", "App Server 输出了无法解析的 JSONL")
      return
    }

    if ("id" in message && "method" in message) {
      this.rejectUnsupportedServerRequest(message)
    } else if ("id" in message) {
      this.handleResponse(message)
    } else if ("method" in message) {
      this.emit("notification", message)
    }
  }

  private rejectUnsupportedServerRequest(request: JsonRpcServerRequest): void {
    const child = this.child
    if (!child) return
    child.stdin.write(`${JSON.stringify({
      id: request.id,
      error: {
        code: -32601,
        message: `Codex Quota Guard 不支持交互式服务器请求：${request.method}`,
      },
    })}\n`)
    this.emit("diagnostic", `已拒绝不支持的 App Server 请求：${request.method}`)
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    clearTimeout(pending.timeout)
    if (response.error) {
      pending.reject(new Error(`${response.error.code}: ${response.error.message}`))
    } else {
      pending.resolve(response.result)
    }
  }

  private handleExit(error: Error | null): void {
    if (!this.child && this.stopping) return
    this.child = null
    if (error) this.rejectPending(error)
    this.emit("exit", error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/bearer\s+[^\s]+/gi, "Bearer [已脱敏]")
    .replace(/(token|cookie|secret)=\S+/gi, "$1=[已脱敏]")
}
