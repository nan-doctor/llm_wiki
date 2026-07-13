import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { applyQuotaObservation, createInitialState } from "../src/guard/state-machine.js"
import { normalizeRateLimits } from "../src/quota/normalize.js"
import { LocalThresholdReporter } from "../src/report/local-reporter.js"
import { observeAuditPoint } from "../src/audit/timing.js"
import { response, snapshot, window } from "./fixtures.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("LocalThresholdReporter", () => {
  it("只使用本地状态生成 JSON 与 Markdown 报告", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "quota-report-test-"))
    roots.push(root)
    const safeQuota = normalizeRateLimits(response(snapshot({
      primary: window(80, 2_000),
    })), 9_500)
    let state = applyQuotaObservation(createInitialState(), safeQuota, null, 9_500).state
    const quota = normalizeRateLimits(response(snapshot({
      primary: window(98, 2_000),
    })), 10_000)
    state = applyQuotaObservation(state, quota, {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAt: 9_000,
    }, 10_000).state
    state.completedItems.push({ id: "item-1", type: "commandExecution", status: "completed" })
    observeAuditPoint(
      state.lastThresholdEvent!.audit,
      "quotaSnapshotObserved",
      "2026-07-13T00:00:00.000Z",
      100,
    )
    observeAuditPoint(
      state.lastThresholdEvent!.audit,
      "thresholdDetected",
      "2026-07-13T00:00:00.010Z",
      110,
    )
    state.errors.push("Authorization: Bearer secret-report-token")
    const reporter = new LocalThresholdReporter(root, {
      inspectGit: async () => "## main\n M local-file.ts",
    })

    await reporter.write(state)

    const eventId = state.lastThresholdEvent!.id
    const json = await readFile(path.join(root, ".codex-guard", "reports", `${eventId}.json`), "utf8")
    const markdown = await readFile(path.join(root, ".codex-guard", "reports", `${eventId}.md`), "utf8")
    expect(json).toContain("turn-1")
    expect(json).toContain("commandExecution")
    expect(json).toContain('"eventKind": "quotaThreshold"')
    expect(json).toContain('"snapshotToDetectionMs": 10')
    expect(markdown).toContain("本地阈值报告")
    expect(markdown).toContain("事件类型：quotaThreshold")
    expect(markdown).toContain("snapshotToDetectionMs：10")
    expect(markdown).toContain("## main")
    expect(markdown).not.toContain("secret-report-token")
  })
})
