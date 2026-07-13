import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

export interface ProtocolCapabilities {
  rateLimitsRead: boolean
  rateLimitsUpdated: boolean
  turnStart: boolean
  turnInterrupt: boolean
  threadRead: boolean
  goalGet: boolean
  goalSet: boolean
  goalPaused: boolean
  goalResume: boolean
  backgroundTerminalsClean: boolean
  serverRequestHandling: boolean
}

export type CapabilityStatus =
  | "unavailable"
  | "schemaDetected"
  | "runtimeVerified"
  | "degraded"
  | "failed"

export interface CapabilityEvidence {
  schemaDetected: boolean
  runtimeVerified: boolean | null
  status: CapabilityStatus
  detail: string | null
}

export type CapabilityMatrix = {
  [Key in keyof ProtocolCapabilities]: CapabilityEvidence
}

export interface CapabilityEvidenceOptions {
  optional?: boolean
  detail?: string | null
}

const OPTIONAL_CAPABILITIES = new Set<keyof ProtocolCapabilities>([
  "goalGet",
  "goalSet",
  "goalPaused",
  "goalResume",
  "backgroundTerminalsClean",
  "serverRequestHandling",
])

export async function inspectGeneratedProtocol(
  directory: string,
): Promise<ProtocolCapabilities> {
  const contents = await readAllTextFiles(directory)
  const has = (value: string): boolean => contents.includes(value)
  const goalStatuses = await inspectGoalStatuses(directory)
  return {
    rateLimitsRead: has("account/rateLimits/read"),
    rateLimitsUpdated: has("account/rateLimits/updated"),
    turnStart: has("turn/start"),
    turnInterrupt: has("turn/interrupt"),
    threadRead: has("thread/read"),
    goalGet: has("thread/goal/get"),
    goalSet: has("thread/goal/set"),
    goalPaused: goalStatuses.has("paused"),
    goalResume: has("thread/goal/set") && goalStatuses.has("active"),
    backgroundTerminalsClean: has("thread/backgroundTerminals/clean"),
    serverRequestHandling: await hasServerRequests(directory),
  }
}

export async function fingerprintProtocol(directory: string): Promise<string> {
  const aggregate = path.join(directory, "codex_app_server_protocol.v2.schemas.json")
  try {
    return sha256(await readFile(aggregate))
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error
  }

  const files = await listJsonFiles(directory)
  const hash = createHash("sha256")
  for (const file of files) {
    const relative = path.relative(directory, file).split(path.sep).join("/")
    hash.update(relative)
    hash.update("\0")
    hash.update(await readFile(file))
    hash.update("\0")
  }
  return hash.digest("hex")
}

export function buildCapabilityEvidence(
  schemaDetected: boolean,
  runtimeVerified: boolean | undefined,
  options: CapabilityEvidenceOptions = {},
): CapabilityEvidence {
  const runtime = runtimeVerified === undefined ? null : runtimeVerified
  let status: CapabilityStatus
  if (runtime === true) status = "runtimeVerified"
  else if (runtime === false) status = options.optional ? "degraded" : "failed"
  else status = schemaDetected ? "schemaDetected" : "unavailable"
  return {
    schemaDetected,
    runtimeVerified: runtime,
    status,
    detail: options.detail ?? null,
  }
}

export function buildCapabilityMatrix(
  schema: ProtocolCapabilities,
  runtime: Partial<Record<keyof ProtocolCapabilities, boolean>> = {},
  details: Partial<Record<keyof ProtocolCapabilities, string>> = {},
): CapabilityMatrix {
  const evidence = <Key extends keyof ProtocolCapabilities>(key: Key): CapabilityEvidence => (
    buildCapabilityEvidence(schema[key], runtime[key], {
      optional: OPTIONAL_CAPABILITIES.has(key),
      detail: details[key] ?? null,
    })
  )
  return {
    rateLimitsRead: evidence("rateLimitsRead"),
    rateLimitsUpdated: evidence("rateLimitsUpdated"),
    turnStart: evidence("turnStart"),
    turnInterrupt: evidence("turnInterrupt"),
    threadRead: evidence("threadRead"),
    goalGet: evidence("goalGet"),
    goalSet: evidence("goalSet"),
    goalPaused: evidence("goalPaused"),
    goalResume: evidence("goalResume"),
    backgroundTerminalsClean: evidence("backgroundTerminalsClean"),
    serverRequestHandling: evidence("serverRequestHandling"),
  }
}

export function emptyCapabilities(): ProtocolCapabilities {
  return {
    rateLimitsRead: false,
    rateLimitsUpdated: false,
    turnStart: false,
    turnInterrupt: false,
    threadRead: false,
    goalGet: false,
    goalSet: false,
    goalPaused: false,
    goalResume: false,
    backgroundTerminalsClean: false,
    serverRequestHandling: false,
  }
}

async function inspectGoalStatuses(directory: string): Promise<Set<string>> {
  try {
    const schema = JSON.parse(await readFile(
      path.join(directory, "v2", "ThreadGoalSetParams.json"),
      "utf8",
    )) as {
      definitions?: { ThreadGoalStatus?: { enum?: unknown } }
    }
    const statuses = schema.definitions?.ThreadGoalStatus?.enum
    return new Set(Array.isArray(statuses)
      ? statuses.filter((status): status is string => typeof status === "string")
      : [])
  } catch {
    return new Set()
  }
}

async function hasServerRequests(directory: string): Promise<boolean> {
  try {
    const schema = JSON.parse(await readFile(
      path.join(directory, "ServerRequest.json"),
      "utf8",
    )) as { oneOf?: unknown }
    return Array.isArray(schema.oneOf) && schema.oneOf.length > 0
  } catch {
    return false
  }
}

async function readAllTextFiles(directory: string): Promise<string> {
  const files = await listProtocolFiles(directory)
  return (await Promise.all(files.map(async (file) => await readFile(file, "utf8")))).join("\n")
}

async function listJsonFiles(directory: string): Promise<string[]> {
  return (await listProtocolFiles(directory)).filter((file) => file.endsWith(".json"))
}

async function listProtocolFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.name.endsWith(".json") || entry.name.endsWith(".ts")) files.push(file)
    }
  }
  await visit(directory)
  return files
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
