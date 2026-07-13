import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import readline, { type Interface as ReadlineInterface } from "node:readline"
import { sanitizeDiagnostic } from "../persistence/state-store.js"
import { parseJsonRpcMessage, type JsonRpcMessage } from "./json-rpc.js"

export interface RawAppServerProcessOptions {
  codexPath: string
  codexArgsPrefix?: string[]
  enableGoals?: boolean
  environment?: NodeJS.ProcessEnv
}

const REMOTE_TOKEN_ENVIRONMENT_KEY = "CODEX_QUOTA_GUARD_REMOTE_TOKEN"
const STOP_TIMEOUT_MS = 2_000

export class RawAppServerProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private lines: ReadlineInterface | null = null
  private stopping = false
  private exitPromise: Promise<void> | null = null
  private resolveExit: (() => void) | null = null
  private readonly completedChildren = new WeakSet<ChildProcessWithoutNullStreams>()

  constructor(private readonly options: RawAppServerProcessOptions) {
    super()
  }

  async start(): Promise<void> {
    if (this.child) return
    this.stopping = false
    const environment = { ...this.options.environment ?? process.env }
    delete environment[REMOTE_TOKEN_ENVIRONMENT_KEY]
    const args = [
      ...this.options.codexArgsPrefix ?? [],
      ...this.options.enableGoals ? ["--enable", "goals"] : [],
      "app-server",
      "--listen",
      "stdio://",
    ]
    const child = spawn(this.options.codexPath, args, {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    this.child = child
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve
    })

    const lines = readline.createInterface({ input: child.stdout })
    this.lines = lines
    lines.on("line", (line) => this.handleLine(line))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      this.emit("diagnostic", sanitizeDiagnostic(chunk))
    })
    child.once("error", (error) => this.handleExit(child, error))
    child.once("exit", (code, signal) => {
      const error = this.stopping
        ? null
        : new Error(`App Server 已退出：code=${String(code)} signal=${String(signal)}`)
      this.handleExit(child, error)
    })

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off("error", onError)
        resolve()
      }
      const onError = (error: Error): void => {
        child.off("spawn", onSpawn)
        reject(error)
      }
      child.once("spawn", onSpawn)
      child.once("error", onError)
    })
  }

  send(message: JsonRpcMessage): void {
    const child = this.child
    if (!child || !child.stdin.writable) throw new Error("App Server 尚未启动")
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  async stop(): Promise<void> {
    const child = this.child
    const exited = this.exitPromise
    if (!child) {
      if (exited) await exited
      return
    }
    this.stopping = true
    if (!child.killed) child.kill("SIGTERM")
    if (!exited) return

    let timedOut = false
    let timeout: NodeJS.Timeout | null = null
    try {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true
            resolve()
          }, STOP_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    if (timedOut && this.child === child) {
      child.kill("SIGKILL")
      await exited
    }
  }

  private handleLine(line: string): void {
    try {
      this.emit("message", parseJsonRpcMessage(line))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.emit("diagnostic", sanitizeDiagnostic(`App Server JSONL 解析失败：${detail}`))
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error | null): void {
    if (this.completedChildren.has(child)) return
    this.completedChildren.add(child)
    if (this.child === child) this.child = null
    this.lines?.close()
    this.lines = null
    this.resolveExit?.()
    this.resolveExit = null
    if (!this.stopping) this.emit("exit", error)
  }
}
