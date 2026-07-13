import { createHash, timingSafeEqual } from "node:crypto"
import { EventEmitter } from "node:events"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import http, { type IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import os from "node:os"
import path from "node:path"
import WebSocket, { WebSocketServer } from "ws"
import { parseJsonRpcMessage, type JsonRpcMessage } from "./json-rpc.js"
import type { JsonRpcPeer } from "./transparent-proxy.js"

export interface LocalTuiEndpointOptions {
  platform: NodeJS.Platform
  token: string
  temporaryRoot?: string
}

export class LocalTuiEndpoint extends EventEmitter implements JsonRpcPeer {
  private readonly server = http.createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  private readonly webSocketServer = new WebSocketServer({ noServer: true })
  private client: WebSocket | null = null
  private addressValue = ""
  private temporaryDirectoryValue: string | null = null
  private token: string | null
  private stopPromise: Promise<void> | null = null

  private constructor(private readonly options: LocalTuiEndpointOptions) {
    super()
    this.token = options.token
    this.server.on("upgrade", this.handleUpgrade)
    this.webSocketServer.on("connection", this.handleConnection)
  }

  get address(): string {
    return this.addressValue
  }

  get temporaryDirectory(): string | null {
    return this.temporaryDirectoryValue
  }

  static async create(options: LocalTuiEndpointOptions): Promise<LocalTuiEndpoint> {
    const endpoint = new LocalTuiEndpoint(options)
    await endpoint.listen()
    return endpoint
  }

  send(message: JsonRpcMessage): void {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) {
      throw new Error("TUI 尚未连接")
    }
    this.client.send(JSON.stringify(message))
  }

  async closeClient(code = 1000, reason = "会话已结束"): Promise<void> {
    const client = this.client
    if (!client || client.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      let timeout: NodeJS.Timeout | null = null
      const finish = (): void => {
        if (timeout) clearTimeout(timeout)
        resolve()
      }
      client.once("close", finish)
      if (client.readyState === WebSocket.OPEN) client.close(code, reason)
      else client.terminate()
      timeout = setTimeout(() => {
        client.terminate()
        finish()
      }, 500)
      timeout.unref()
    })
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return await this.stopPromise
    this.stopPromise = this.stopInternal()
    await this.stopPromise
  }

  private async listen(): Promise<void> {
    if (this.options.platform === "win32") {
      await listen(this.server, 0, "127.0.0.1")
      const address = this.server.address()
      if (!address || typeof address === "string") {
        throw new Error("无法确定本地 TUI endpoint 端口")
      }
      this.addressValue = `ws://127.0.0.1:${address.port}`
      return
    }

    const root = this.options.temporaryRoot ?? os.tmpdir()
    const directory = await mkdtemp(path.join(root, "cqg-"))
    this.temporaryDirectoryValue = directory
    await chmod(directory, 0o700)
    const socketPath = path.join(directory, "app-server.sock")
    try {
      await listen(this.server, socketPath)
      await chmod(socketPath, 0o600)
      this.addressValue = `unix://${socketPath}`
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      this.temporaryDirectoryValue = null
      throw error
    }
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const token = this.token
    if (!token || !tokenMatches(request.headers.authorization, token)) {
      rejectUpgrade(socket, 401, "Unauthorized")
      return
    }
    if (this.client && this.client.readyState !== WebSocket.CLOSED) {
      rejectUpgrade(socket, 409, "Conflict")
      return
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (client) => {
      this.webSocketServer.emit("connection", client, request)
    })
  }

  private readonly handleConnection = (client: WebSocket): void => {
    this.client = client
    client.on("message", (data, isBinary) => {
      if (isBinary) {
        this.emit("diagnostic", "TUI 发送了不支持的二进制 WebSocket 消息")
        return
      }
      try {
        this.emit("message", parseJsonRpcMessage(data.toString()))
      } catch {
        this.emit("diagnostic", "TUI 发送了无法解析的 JSON-RPC 消息")
      }
    })
    client.once("close", () => {
      if (this.client === client) this.client = null
      this.emit("close")
    })
    client.on("error", (error) => this.emit("diagnostic", error.message))
  }

  private async stopInternal(): Promise<void> {
    await this.closeClient()
    this.server.off("upgrade", this.handleUpgrade)
    this.webSocketServer.off("connection", this.handleConnection)
    await closeWebSocketServer(this.webSocketServer)
    await closeServer(this.server)
    const directory = this.temporaryDirectoryValue
    this.temporaryDirectoryValue = null
    if (directory) await rm(directory, { recursive: true, force: true })
    this.token = null
    this.removeAllListeners()
  }
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : ""
  const left = createHash("sha256").update(actual).digest()
  const right = createHash("sha256").update(expected).digest()
  return timingSafeEqual(left, right)
}

function rejectUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`)
  socket.destroy()
}

function listen(server: http.Server, ...args: [number, string] | [string]): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    if (args.length === 1) server.listen(args[0])
    else server.listen(args[0], args[1])
  })
}

function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}
