import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import path from "node:path"

export interface TuiProcessOptions {
  executable: string
  remoteAddress: string
  tokenEnvironmentName: string
  token: string
  tuiArgs: string[]
  environment?: NodeJS.ProcessEnv
}

export interface TuiExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export type TuiProcessSpawner = (
  executable: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess

const STOP_TIMEOUT_MS = 2_000

export class TuiProcess {
  private readonly executable: string
  private readonly remoteAddress: string
  private readonly tokenEnvironmentName: string
  private readonly tuiArgs: string[]
  private readonly environment: NodeJS.ProcessEnv
  private child: ChildProcess | null = null
  private token: string | null
  private exitSettled = false
  private readonly exitPromise: Promise<TuiExit>
  private readonly resolveExit: (exit: TuiExit) => void

  constructor(
    options: TuiProcessOptions,
    private readonly spawner: TuiProcessSpawner = spawn,
  ) {
    this.executable = options.executable
    this.remoteAddress = options.remoteAddress
    this.tokenEnvironmentName = options.tokenEnvironmentName
    this.tuiArgs = [...options.tuiArgs]
    this.environment = { ...options.environment ?? process.env }
    delete this.environment[this.tokenEnvironmentName]
    this.token = options.token
    let resolveExit!: (exit: TuiExit) => void
    this.exitPromise = new Promise((resolve) => {
      resolveExit = resolve
    })
    this.resolveExit = resolveExit
  }

  async start(): Promise<void> {
    if (this.child) return
    if (!path.isAbsolute(this.executable)) {
      throw new Error("原生 Codex TUI 必须使用已验证的绝对路径")
    }
    const token = this.token
    if (!token) throw new Error("TUI capability token 不可用")
    const args = [
      "--remote",
      this.remoteAddress,
      "--remote-auth-token-env",
      this.tokenEnvironmentName,
      ...this.tuiArgs,
    ]
    const child = this.spawner(this.executable, args, {
      env: {
        ...this.environment,
        [this.tokenEnvironmentName]: token,
      },
      stdio: "inherit",
      windowsHide: true,
    })
    this.child = child
    child.once("exit", (code, signal) => this.settleExit({ code, signal }))
    child.once("error", () => this.settleExit({ code: 1, signal: null }))
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

  async waitForExit(): Promise<TuiExit> {
    return await this.exitPromise
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child && !this.exitSettled) {
      child.kill("SIGTERM")
      const exited = await waitWithTimeout(this.exitPromise, STOP_TIMEOUT_MS)
      if (!exited && !this.exitSettled) {
        child.kill("SIGKILL")
        const killed = await waitWithTimeout(this.exitPromise, 500)
        if (!killed && !this.exitSettled) {
          this.settleExit({ code: null, signal: "SIGKILL" })
        }
      }
    }
    this.token = null
  }

  private settleExit(exit: TuiExit): void {
    if (this.exitSettled) return
    this.exitSettled = true
    this.child = null
    this.resolveExit(exit)
  }
}

async function waitWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
