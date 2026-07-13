import { describe, expect, it } from "vitest"
import { applyQuotaObservation, createInitialState } from "../src/guard/state-machine.js"
import { normalizeRateLimits } from "../src/quota/normalize.js"
import { buildStatusOutput, formatStatusText } from "../src/ui/status.js"
import { response, snapshot, window } from "./fixtures.js"

function handledCriticalState() {
  let state = applyQuotaObservation(createInitialState(), normalizeRateLimits(response(snapshot({
    primary: window(60, 8_000, 10_080),
    secondary: window(80, 2_000, 300),
  })), 9_000), null, 9_000).state
  const quota = normalizeRateLimits(response(snapshot({
    primary: window(60, 8_000, 10_080),
    secondary: window(98.2, 2_000, 300),
  })), 10_000)
  return applyQuotaObservation(state, quota, null, 10_000).state
}

describe("状态输出", () => {
  it("文本同时显示 used、left、quota、guard 和 turns", () => {
    const output = buildStatusOutput(handledCriticalState(), 10_100)
    const text = formatStatusText(output, "zh-CN", "UTC")

    expect(text).toContain("5h: 98.2% used · 1.8% left")
    expect(text).toContain("weekly: 60% used · 40% left")
    expect(text).toContain("windowDurationMins=300")
    expect(text).toContain("windowDurationMins=10080")
    expect(text).toContain("quota: CRITICAL (1.8% left)")
    expect(text).toContain("overall: 1.8% left")
    expect(text).toContain("guard: HANDLED")
    expect(text).toContain("turns: ALLOWED")
  })

  it("JSON 输出符合稳定 schema", () => {
    const output = buildStatusOutput(handledCriticalState(), 10_100)

    expect(output).toMatchObject({
      schemaVersion: 1,
      stale: false,
      protectedWindow: {
        available: true,
        reason: "available",
        awaitingBaseline: false,
      },
      quota: {
        source: "rateLimitsByLimitId.codex",
        protectedRemainingPercent: 1.8,
        overallRemainingPercent: 1.8,
        severity: "CRITICAL",
      },
      guard: {
        state: "HANDLED",
        thresholdHandled: true,
      },
      turns: "ALLOWED",
      active: null,
    })
  })

  it("过期额度变为 UNKNOWN，但不改变 HANDLED 事实", () => {
    const output = buildStatusOutput(handledCriticalState(), 200_000, {
      staleAfterMs: 90_000,
    })

    expect(output.stale).toBe(true)
    expect(output.quota.severity).toBe("UNKNOWN")
    expect(output.guard.state).toBe("HANDLED")
    expect(output.guard.thresholdHandled).toBe(true)
    expect(output.turns).toBe("BLOCKED")
  })

  it("仅有 weekly 时显示保护不可用、DORMANT、ALLOWED 并保留 weekly 诊断", () => {
    const quota = normalizeRateLimits(response(snapshot({
      primary: window(98, 8_000, 10_080),
      secondary: null,
    })), 10_000)
    const state = applyQuotaObservation(createInitialState(), quota, null, 10_000).state
    const text = formatStatusText(buildStatusOutput(state, 10_100), "zh-CN", "UTC")

    expect(text).toContain("weekly: 98% used · 2% left")
    expect(text).toContain("overall: 2% left")
    expect(text).toContain("5h protection: UNAVAILABLE")
    expect(text).not.toContain("quota: UNKNOWN")
    expect(text).toContain("guard: DORMANT")
    expect(text).toContain("turns: ALLOWED")
    expect(buildStatusOutput(state, 10_100).protectedWindow).toEqual({
      available: false,
      reason: "five-hour-window-unavailable",
      awaitingBaseline: false,
    })
  })

  it("冷启动首次看到 CRITICAL 时显示 awaitingBaseline 而不伪造下降沿", () => {
    const quota = normalizeRateLimits(response(snapshot({
      primary: window(98.5, 2_000, 300),
      secondary: window(40, 8_000, 10_080),
    })), 10_000)
    const transition = applyQuotaObservation(createInitialState(), quota, null, 10_000)
    const output = buildStatusOutput(transition.state, 10_100)
    const text = formatStatusText(output, "zh-CN", "UTC")

    expect(transition.event).toBeNull()
    expect(output.protectedWindow).toEqual({
      available: true,
      reason: "available",
      awaitingBaseline: true,
    })
    expect(text).toContain("awaiting baseline")
  })
})
