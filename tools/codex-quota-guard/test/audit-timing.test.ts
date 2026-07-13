import { describe, expect, it } from "vitest"
import {
  createAuditRecord,
  finalizeLatencies,
  observeAuditPoint,
} from "../src/audit/timing.js"

describe("额度事件时序审计", () => {
  it("只用单调时间计算四段时延", () => {
    const audit = createAuditRecord("quotaThreshold")
    observeAuditPoint(audit, "quotaSnapshotObserved", "2026-07-13T00:00:00.000Z", 100)
    observeAuditPoint(audit, "thresholdDetected", "2026-07-13T00:00:00.010Z", 110)
    observeAuditPoint(audit, "interruptRequested", "2026-07-13T00:00:00.015Z", 115)
    observeAuditPoint(audit, "interruptAcknowledged", "2026-07-13T00:00:00.025Z", 125)

    expect(finalizeLatencies(audit)).toEqual({
      snapshotToDetectionMs: 10,
      detectionToInterruptRequestMs: 5,
      interruptRequestToAcknowledgementMs: 10,
      interruptRequestToTerminalStateMs: null,
    })
    expect(audit).toMatchObject({
      eventKind: "quotaThreshold",
      quotaSnapshotObservedAt: "2026-07-13T00:00:00.000Z",
      thresholdDetectedAt: "2026-07-13T00:00:00.010Z",
      interruptRequestedAt: "2026-07-13T00:00:00.015Z",
      interruptAcknowledgedAt: "2026-07-13T00:00:00.025Z",
      turnTerminalStateObservedAt: null,
    })
  })

  it("缺少时间点时保持 null，且不把 UTC 墙钟差当作时延", () => {
    const audit = createAuditRecord("liveCanary")
    observeAuditPoint(audit, "interruptRequested", "2026-07-13T00:00:10.000Z", 200)
    observeAuditPoint(audit, "interruptAcknowledged", "2026-07-12T23:59:00.000Z", 207)

    expect(finalizeLatencies(audit)).toEqual({
      snapshotToDetectionMs: null,
      detectionToInterruptRequestMs: null,
      interruptRequestToAcknowledgementMs: 7,
      interruptRequestToTerminalStateMs: null,
    })
  })
})
