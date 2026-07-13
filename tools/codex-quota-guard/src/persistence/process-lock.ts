import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import path from "node:path"

export interface ProcessLockOptions {
  heartbeatMs?: number
  staleMs?: number
}

export class ProcessLock {
  private heartbeat: NodeJS.Timeout | null
  private released = false

  private constructor(
    private readonly lockDirectory: string,
    heartbeatMs: number,
  ) {
    this.heartbeat = setInterval(() => {
      const now = new Date()
      void utimes(this.lockDirectory, now, now).catch(() => undefined)
    }, heartbeatMs)
    this.heartbeat.unref()
  }

  static async acquire(
    rootDirectory: string,
    options: ProcessLockOptions = {},
  ): Promise<ProcessLock> {
    const heartbeatMs = options.heartbeatMs ?? 5_000
    const staleMs = options.staleMs ?? 30_000
    const stateDirectory = path.join(rootDirectory, ".codex-guard")
    const lockDirectory = path.join(stateDirectory, "controller.lock")
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 })

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 })
        await writeFile(path.join(lockDirectory, "owner.json"), `${JSON.stringify({
          pid: process.pid,
          startedAt: Date.now(),
        })}\n`, { mode: 0o600 })
        return new ProcessLock(lockDirectory, heartbeatMs)
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error
        const existing = await stat(lockDirectory).catch(() => null)
        if (!existing) continue
        if (Date.now() - existing.mtimeMs <= staleMs) {
          throw new Error("已有 Codex Quota Guard 控制器正在运行")
        }
        const ownerPid = await readOwnerPid(lockDirectory)
        if (ownerPid !== null && isProcessAlive(ownerPid)) {
          throw new Error("已有 Codex Quota Guard 控制器正在运行")
        }

        const quarantine = `${lockDirectory}.stale-${process.pid}-${Date.now()}`
        try {
          await rename(lockDirectory, quarantine)
          await rm(quarantine, { recursive: true, force: true })
        } catch (takeoverError) {
          if (!isNodeError(takeoverError) || takeoverError.code !== "ENOENT") {
            throw takeoverError
          }
        }
      }
    }

    throw new Error("无法取得 Codex Quota Guard 控制器锁")
  }

  stopHeartbeatForTest(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.stopHeartbeatForTest()
    await rm(this.lockDirectory, { recursive: true, force: true })
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

async function readOwnerPid(lockDirectory: string): Promise<number | null> {
  try {
    const owner = JSON.parse(await readFile(path.join(lockDirectory, "owner.json"), "utf8")) as {
      pid?: unknown
    }
    return typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0
      ? owner.pid
      : null
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM"
  }
}
