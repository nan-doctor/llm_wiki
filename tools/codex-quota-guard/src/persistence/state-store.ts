import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import type { PersistedGuardState } from "../guard/state-machine.js"
import { createAuditRecord } from "../audit/timing.js"
import type { GuardStateRepository } from "./repository.js"

const SENSITIVE_KEY = /^(access.?token|refresh.?token|token|authorization|cookie|secret|api.?key)$/i
const BEARER_VALUE = /bearer\s+[^\s"']+/gi
const SENSITIVE_ASSIGNMENT = /\b(access[_-]?token|refresh[_-]?token|token|authorization|cookie|secret|api[_-]?key)\b\s*[:=]\s*(?:(?:bearer|basic|token)\s+)?[^\s,"']+/gi

export class StateStore implements GuardStateRepository {
  readonly stateDirectory: string
  readonly statePath: string

  constructor(rootDirectory: string) {
    this.stateDirectory = path.join(rootDirectory, ".codex-guard")
    this.statePath = path.join(this.stateDirectory, "state.json")
  }

  async load(): Promise<PersistedGuardState | null> {
    let raw: string
    try {
      raw = await readFile(this.statePath, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null
      throw error
    }
    const value = JSON.parse(raw) as PersistedGuardState
    if (value.schemaVersion !== 1) {
      throw new Error(`不支持的状态文件版本：${String(value.schemaVersion)}`)
    }
    value.limits.requireProtection ??= false
    value.limits.requireGoalControl ??= false
    value.goalControl ??= "unavailable"
    value.activeThreadId ??= value.activeTurn?.threadId ?? null
    if (value.lastThresholdEvent) {
      value.lastThresholdEvent.goalErrorCategory ??= null
      value.lastThresholdEvent.audit ??= createAuditRecord("quotaThreshold")
    }
    value.runtime ??= {
      task: null,
      current: null,
      capabilities: null,
      changes: [],
    }
    return value
  }

  async save(state: PersistedGuardState): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.statePath}.tmp-${process.pid}-${randomSuffix()}`
    const sanitized = sanitizeForPersistence(state) as PersistedGuardState
    const content = `${JSON.stringify(sanitized, null, 2)}\n`
    const handle = await open(temporaryPath, "wx", 0o600)
    try {
      await handle.writeFile(content, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      await rename(temporaryPath, this.statePath)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }
}

export function sanitizeForPersistence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForPersistence)
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue
      clean[key] = sanitizeForPersistence(nested)
    }
    return clean
  }
  if (typeof value === "string") {
    return sanitizeDiagnostic(value)
  }
  return value
}

export function sanitizeDiagnostic(value: string): string {
  return value
    .replace(SENSITIVE_ASSIGNMENT, "$1=[已脱敏]")
    .replace(BEARER_VALUE, "Bearer [已脱敏]")
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
