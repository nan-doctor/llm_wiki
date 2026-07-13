import type { EventEmitter } from "node:events"
import type { JsonRpcPeer } from "../proxy/transparent-proxy.js"
import type { TuiExit } from "./tui-process.js"

export interface InteractiveRunOptions {
  tuiArgs: string[]
  requireProtection: boolean
}

export interface SessionRawAppServer extends EventEmitter {
  start(): Promise<void>
  stop(): Promise<void>
}

export interface SessionEndpoint extends EventEmitter, JsonRpcPeer {
  readonly address: string
  closeClient(code?: number, reason?: string): Promise<void>
  stop(): Promise<void>
}

export interface SessionProxy extends EventEmitter {
  start(): void
  pauseDownstream(): void
  stop(error?: Error): void
}

export interface SessionController {
  start(): Promise<void>
  shutdownInteractiveSession(): Promise<void>
  stop(): Promise<void>
}

export interface SessionTui {
  start(): Promise<void>
  waitForExit(): Promise<TuiExit>
  stop(): Promise<void>
}

export interface SessionTuiOptions {
  remoteAddress: string
  tokenEnvironmentName: string
  token: string
  tuiArgs: string[]
}

export interface InteractiveSessionDependencies {
  runPreflight(options: { requireProtection: boolean }): Promise<unknown>
  raw: SessionRawAppServer
  createToken(): string
  createEndpoint(token: string): Promise<SessionEndpoint>
  createProxy(endpoint: SessionEndpoint, raw: SessionRawAppServer): SessionProxy
  createController(proxy: SessionProxy): SessionController
  createTui(options: SessionTuiOptions): SessionTui
  tokenEnvironmentName: string
  signalSource: Pick<EventEmitter, "on" | "off">
}

interface Termination {
  code: number
  reason: string
}

export class InteractiveSession {
  private endpoint: SessionEndpoint | null = null
  private proxy: SessionProxy | null = null
  private controller: SessionController | null = null
  private tui: SessionTui | null = null
  private token: string | null = null
  private rawStarted = false
  private proxyStarted = false
  private controllerStarted = false
  private tuiStarted = false
  private running = false
  private stopPromise: Promise<void> | null = null
  private terminationPromise: Promise<Termination> | null = null
  private finishTermination: ((termination: Termination) => void) | null = null
  private readonly listeners: Array<{
    emitter: Pick<EventEmitter, "off">
    event: string
    listener: (...args: unknown[]) => void
  }> = []

  constructor(private readonly dependencies: InteractiveSessionDependencies) {}

  async run(options: InteractiveRunOptions): Promise<number> {
    if (this.running) throw new Error("交互会话已经启动")
    this.running = true
    this.initializeTermination()
    this.installSignalListeners()
    this.listen(this.dependencies.raw, "exit", () => {
      this.terminate(1, "App Server 已退出")
    })
    try {
      await this.dependencies.runPreflight({ requireProtection: options.requireProtection })
      await this.dependencies.raw.start()
      this.rawStarted = true
      this.token = this.dependencies.createToken()
      this.endpoint = await this.dependencies.createEndpoint(this.token)
      this.listen(this.endpoint, "close", () => this.terminate(1, "TUI endpoint 已断开"))
      this.proxy = this.dependencies.createProxy(this.endpoint, this.dependencies.raw)
      this.listen(this.proxy, "exit", () => this.terminate(1, "JSON-RPC 代理已退出"))
      this.listen(this.proxy, "error", () => this.terminate(1, "JSON-RPC 代理异常"))
      this.controller = this.dependencies.createController(this.proxy)
      this.tui = this.dependencies.createTui({
        remoteAddress: this.endpoint.address,
        tokenEnvironmentName: this.dependencies.tokenEnvironmentName,
        token: this.token,
        tuiArgs: [...options.tuiArgs],
      })
      this.proxy.start()
      this.proxyStarted = true
      const controllerReady = this.controller.start()
      this.controllerStarted = true
      void controllerReady.catch(() => this.terminate(1, "交互控制器启动失败"))
      await this.tui.start()
      this.tuiStarted = true
      void this.tui.waitForExit()
        .then((exit) => this.terminate(exitCode(exit), "原生 TUI 已退出"))
        .catch(() => this.terminate(1, "原生 TUI 等待失败"))

      const termination = await this.terminationPromise!
      await this.stop(termination.reason)
      return termination.code
    } catch (error) {
      await this.stop("交互会话启动失败")
      throw error
    }
  }

  async stop(_reason: string): Promise<void> {
    if (this.stopPromise) return await this.stopPromise
    this.stopPromise = this.stopInternal()
    await this.stopPromise
  }

  private async stopInternal(): Promise<void> {
    await attempt(() => this.proxy?.pauseDownstream())
    if (this.controllerStarted) {
      await attempt(async () => await this.controller?.shutdownInteractiveSession())
      await attempt(async () => await this.controller?.stop())
    }
    if (this.proxyStarted) await attempt(() => this.proxy?.stop())
    if (this.endpoint) await attempt(async () => await this.endpoint?.closeClient())
    if (this.tuiStarted) await attempt(async () => await this.tui?.stop())
    if (this.rawStarted) await attempt(async () => await this.dependencies.raw.stop())
    if (this.endpoint) await attempt(async () => await this.endpoint?.stop())
    this.removeListeners()
    this.token = null
    this.running = false
  }

  private initializeTermination(): void {
    this.terminationPromise = new Promise((resolve) => {
      this.finishTermination = resolve
    })
  }

  private terminate(code: number, reason: string): void {
    const finish = this.finishTermination
    if (!finish) return
    this.finishTermination = null
    finish({ code, reason })
  }

  private installSignalListeners(): void {
    this.listen(this.dependencies.signalSource, "SIGINT", () => this.terminate(130, "SIGINT"))
    this.listen(this.dependencies.signalSource, "SIGTERM", () => this.terminate(143, "SIGTERM"))
    this.listen(this.dependencies.signalSource, "SIGHUP", () => this.terminate(129, "SIGHUP"))
  }

  private listen(
    emitter: Pick<EventEmitter, "on" | "off">,
    event: string,
    listener: (...args: unknown[]) => void,
  ): void {
    emitter.on(event, listener)
    this.listeners.push({ emitter, event, listener })
  }

  private removeListeners(): void {
    for (const { emitter, event, listener } of this.listeners.splice(0)) {
      emitter.off(event, listener)
    }
  }
}

function exitCode(exit: TuiExit): number {
  if (exit.code !== null) return exit.code
  if (exit.signal === "SIGINT") return 130
  if (exit.signal === "SIGHUP") return 129
  if (exit.signal === "SIGTERM") return 143
  return 1
}

async function attempt(action: () => void | Promise<void>): Promise<void> {
  try {
    await action()
  } catch {
    // 清理路径继续处理其余本会话资源。
  }
}
