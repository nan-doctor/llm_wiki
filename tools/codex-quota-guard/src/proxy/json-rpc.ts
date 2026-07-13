export type JsonRpcId = string | number | null

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
  [key: string]: unknown
}

export interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: JsonRpcErrorObject
  [key: string]: unknown
}

export function parseJsonRpcMessage(line: string): JsonRpcMessage {
  const value = JSON.parse(line) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("App Server 输出必须是 JSON 对象")
  }
  return value as JsonRpcMessage
}

export function hasMethod(message: JsonRpcMessage): boolean {
  return typeof message.method === "string"
}

export function hasId(message: JsonRpcMessage): boolean {
  return Object.prototype.hasOwnProperty.call(message, "id")
}

export function withId(message: JsonRpcMessage, id: JsonRpcId): JsonRpcMessage {
  return { ...message, id }
}
