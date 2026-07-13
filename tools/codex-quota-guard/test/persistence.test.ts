import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createInitialState } from "../src/guard/state-machine.js"
import { ProcessLock } from "../src/persistence/process-lock.js"
import { StateStore } from "../src/persistence/state-store.js"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-quota-guard-test-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

describe("StateStore", () => {
  it("原子保存并重新加载状态", async () => {
    const root = await temporaryDirectory()
    const store = new StateStore(root)
    const state = createInitialState()
    state.updatedAt = 123
    state.guard.state = "HANDLED"
    state.guard.thresholdHandled = true

    await store.save(state)

    state.updatedAt = 456
    state.guard.state = "ARMED"
    state.guard.thresholdHandled = false
    await store.save(state)

    expect(await store.load()).toEqual(state)
    const files = await readdir(path.join(root, ".codex-guard"))
    expect(files.filter((file) => file.includes(".tmp-"))).toEqual([])
  })

  it("持久化前移除认证字段并脱敏错误文本", async () => {
    const root = await temporaryDirectory()
    const store = new StateStore(root)
    const state = createInitialState()
    state.completedItems.push({
      type: "diagnostic",
      accessToken: "secret-access-token",
      nested: { cookie: "secret-cookie", safe: "kept" },
    })
    state.errors.push("Authorization: Bearer secret-bearer")
    state.errors.push("access_token: secret-access-in-error cookie=session-secret")

    await store.save(state)

    const raw = await readFile(path.join(root, ".codex-guard", "state.json"), "utf8")
    expect(raw).not.toContain("secret-access-token")
    expect(raw).not.toContain("secret-cookie")
    expect(raw).not.toContain("secret-bearer")
    expect(raw).not.toContain("secret-access-in-error")
    expect(raw).not.toContain("session-secret")
    expect(raw).not.toContain("accessToken")
    expect(raw).toContain("kept")
  })
})

describe("ProcessLock", () => {
  it("阻止第二个控制器同时取得锁", async () => {
    const root = await temporaryDirectory()
    const first = await ProcessLock.acquire(root, { heartbeatMs: 60_000, staleMs: 120_000 })

    await expect(ProcessLock.acquire(root, {
      heartbeatMs: 60_000,
      staleMs: 120_000,
    })).rejects.toThrow("已有 Codex Quota Guard 控制器正在运行")

    await first.release()
  })

  it("能够接管已过期的崩溃锁", async () => {
    const root = await temporaryDirectory()
    const lockDirectory = path.join(root, ".codex-guard", "controller.lock")
    await mkdir(lockDirectory, { recursive: true })
    await writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({
      pid: 999_999_999,
      startedAt: 1,
    }))
    const old = new Date(Date.now() - 5_000)
    await utimes(lockDirectory, old, old)
    expect((await stat(lockDirectory)).isDirectory()).toBe(true)

    const second = await ProcessLock.acquire(root, { heartbeatMs: 60_000, staleMs: 1_000 })

    await second.release()
  })

  it("仍存活的控制器即使心跳延迟也不会被误接管", async () => {
    const root = await temporaryDirectory()
    const first = await ProcessLock.acquire(root, { heartbeatMs: 60_000, staleMs: 1_000 })
    first.stopHeartbeatForTest()
    const lockDirectory = path.join(root, ".codex-guard", "controller.lock")
    const old = new Date(Date.now() - 5_000)
    await utimes(lockDirectory, old, old)

    await expect(ProcessLock.acquire(root, {
      heartbeatMs: 60_000,
      staleMs: 1_000,
    })).rejects.toThrow("已有 Codex Quota Guard 控制器正在运行")
    await first.release()
  })
})
