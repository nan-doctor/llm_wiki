import { describe, expect, it } from "vitest"
import { normalizeRateLimits } from "../src/quota/normalize.js"
import { response, snapshot, window } from "./fixtures.js"

describe("normalizeRateLimits", () => {
  it("当前 schema 允许额度快照字段省略，缺失数据稳定归一化为 UNKNOWN", () => {
    const quota = normalizeRateLimits({
      rateLimits: {},
      rateLimitsByLimitId: null,
    }, 10_000)

    expect(quota).toMatchObject({
      source: "rateLimits",
      limitId: null,
      primary: null,
      secondary: null,
      protectedRemainingPercent: null,
      overallRemainingPercent: null,
      severity: "UNKNOWN",
      credits: null,
      windowKey: null,
    })
  })

  it("优先选择 codex 桶并计算最低剩余比例", () => {
    const legacy = snapshot({ limitId: "legacy", primary: window(5, 1_000) })
    const codex = snapshot({
      primary: window(66, 2_000),
      secondary: window(82, 8_000, 10_080),
    })

    const quota = normalizeRateLimits(response(legacy, {
      codex,
      codex_other: snapshot({ limitId: "codex_other", primary: window(99, 3_000) }),
    }), 10_000)

    expect(quota.source).toBe("rateLimitsByLimitId.codex")
    expect(quota.primary?.remainingPercent).toBe(34)
    expect(quota.secondary?.remainingPercent).toBe(18)
    expect(quota.protectedRemainingPercent).toBe(34)
    expect(quota.overallRemainingPercent).toBe(18)
    expect(quota.severity).toBe("SAFE")
  })

  it("codex 桶不存在时回退到 legacy rateLimits", () => {
    const legacy = snapshot({ primary: window(96, 2_000) })
    const quota = normalizeRateLimits(response(legacy, {
      codex_other: snapshot({ limitId: "codex_other" }),
    }), 10_000)

    expect(quota.source).toBe("rateLimits")
    expect(quota.protectedRemainingPercent).toBe(4)
    expect(quota.overallRemainingPercent).toBe(4)
    expect(quota.severity).toBe("WARNING")
  })

  it("primary 98% used 时为 CRITICAL", () => {
    const quota = normalizeRateLimits(response(snapshot({
      primary: window(98, 2_000),
      secondary: window(10, 8_000, 10_080),
    })), 10_000)

    expect(quota.protectedRemainingPercent).toBe(2)
    expect(quota.overallRemainingPercent).toBe(2)
    expect(quota.severity).toBe("CRITICAL")
  })

  it("weekly 98% used 但 5 小时窗口安全时不进入 CRITICAL", () => {
    const quota = normalizeRateLimits(response(snapshot({
      primary: window(98, 8_000, 10_080),
      secondary: window(10, 2_000, 300),
    })), 10_000)

    expect(quota.protectedWindowSlot).toBe("secondary")
    expect(quota.protectedRemainingPercent).toBe(90)
    expect(quota.overallRemainingPercent).toBe(2)
    expect(quota.severity).toBe("SAFE")
    expect(quota.windowKey).toBe("codex:300:2000")
  })

  it("只有 weekly 窗口时 guard 为 UNKNOWN", () => {
    const quota = normalizeRateLimits(response(snapshot({
      primary: window(98, 8_000, 10_080),
      secondary: null,
    })), 10_000)

    expect(quota.protectedRemainingPercent).toBeNull()
    expect(quota.overallRemainingPercent).toBe(2)
    expect(quota.severity).toBe("UNKNOWN")
    expect(quota.windowKey).toBeNull()
  })

  it("credits 只保留显示信息，不绕过 CRITICAL", () => {
    const quota = normalizeRateLimits(response(snapshot({
      primary: window(98, 2_000),
      credits: { hasCredits: true, unlimited: true, balance: "999" },
    })), 10_000)

    expect(quota.credits).toEqual({ hasCredits: true, unlimited: true, balance: "999" })
    expect(quota.severity).toBe("CRITICAL")
  })
})
