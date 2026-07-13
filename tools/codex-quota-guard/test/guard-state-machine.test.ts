import { describe, expect, it } from "vitest"
import {
  applyQuotaObservation,
  applyStaleQuota,
  completeThresholdHandling,
  createInitialState,
} from "../src/guard/state-machine.js"
import { normalizeRateLimits } from "../src/quota/normalize.js"
import { response, snapshot, window } from "./fixtures.js"

const safe = (fiveHourReset = 2_000, weeklyReset = 8_000) => normalizeRateLimits(response(snapshot({
  primary: window(80, weeklyReset, 10_080),
  secondary: window(80, fiveHourReset, 300),
})), 10_000)

const critical = (fiveHourReset = 2_000, weeklyReset = 8_000) => normalizeRateLimits(response(snapshot({
  primary: window(80, weeklyReset, 10_080),
  secondary: window(98, fiveHourReset, 300),
})), 11_000)

describe("额度边沿状态机", () => {
  it("初始状态不绑定任何交互 thread", () => {
    expect(createInitialState().activeThreadId).toBeNull()
  })

  it("从安全跨到 CRITICAL 时固定快照原 active turn", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    const oldTurn = { threadId: "thread-old", turnId: "turn-old", startedAt: 10_100 }
    state.activeTurn = oldTurn

    const transition = applyQuotaObservation(state, critical(), oldTurn, 11_000)

    expect(transition.event?.target).toEqual(oldTurn)
    expect(transition.state.guard.state).toBe("HANDLING")
    expect(transition.state.guard.thresholdHandled).toBe(true)
    expect(transition.state.lastThresholdEvent?.target?.turnId).toBe("turn-old")
  })

  it("HANDLED 后同一窗口不再中断后来启动的 turn", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    const oldTurn = { threadId: "thread", turnId: "turn-old", startedAt: 10_100 }
    let transition = applyQuotaObservation(state, critical(), oldTurn, 11_000)
    state = completeThresholdHandling(transition.state, transition.event!.id, 11_100)
    const newTurn = { threadId: "thread", turnId: "turn-new", startedAt: 12_000 }

    transition = applyQuotaObservation(state, critical(), newTurn, 12_100)

    expect(transition.event).toBeNull()
    expect(transition.state.guard.state).toBe("HANDLED")
    expect(transition.admission).toBe("ALLOWED")
    expect(transition.state.lastThresholdEvent?.target?.turnId).toBe("turn-old")
  })

  it("没有 active turn 时仍处理窗口但不产生中断目标", () => {
    const armed = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    const transition = applyQuotaObservation(armed, critical(), null, 11_000)

    expect(transition.event?.target).toBeNull()
    expect(transition.state.guard.state).toBe("HANDLED")
    expect(transition.state.guard.thresholdHandled).toBe(true)
    expect(transition.admission).toBe("ALLOWED")
  })

  it("进程重启加载 HANDLED 状态后不重复触发", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    const turn = { threadId: "thread", turnId: "turn-old", startedAt: 10_100 }
    const transition = applyQuotaObservation(state, critical(), turn, 11_000)
    state = completeThresholdHandling(transition.state, transition.event!.id, 11_100)
    const restartedState = structuredClone(state)

    const afterRestart = applyQuotaObservation(restartedState, critical(), {
      threadId: "thread",
      turnId: "turn-new",
      startedAt: 12_000,
    }, 12_100)

    expect(afterRestart.event).toBeNull()
    expect(afterRestart.admission).toBe("ALLOWED")
  })

  it("HANDLING 中重启时不会被额度恢复或新窗口覆盖固定事件", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    const target = { threadId: "thread", turnId: "turn-fixed", startedAt: 10_100 }
    state = applyQuotaObservation(state, critical(), target, 11_000).state

    const afterReconnect = applyQuotaObservation(state, safe(3_000), {
      threadId: "thread",
      turnId: "turn-later",
      startedAt: 12_000,
    }, 12_100)

    expect(afterReconnect.state.guard.state).toBe("HANDLING")
    expect(afterReconnect.state.lastThresholdEvent?.target?.turnId).toBe("turn-fixed")
    expect(afterReconnect.event).toBeNull()
  })

  it("5 小时 resetsAt 改变后重新布防，观察到新边沿后只处理一次", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    const first = applyQuotaObservation(state, critical(), null, 11_000)
    state = first.state

    const second = applyQuotaObservation(state, critical(3_000), {
      threadId: "thread",
      turnId: "turn-new-window",
      startedAt: 12_000,
    }, 12_100)

    expect(second.event).toBeNull()
    expect(second.state.guard.state).toBe("ARMED")

    state = applyQuotaObservation(second.state, safe(3_000), null, 12_200).state
    const crossed = applyQuotaObservation(state, critical(3_000), {
      threadId: "thread",
      turnId: "turn-new-window",
      startedAt: 12_300,
    }, 12_400)
    expect(crossed.event?.target?.turnId).toBe("turn-new-window")
  })

  it("weekly 为 98% used 但 5 小时窗口安全时不触发", () => {
    const weeklyCritical = normalizeRateLimits(response(snapshot({
      primary: window(98, 8_000, 10_080),
      secondary: window(80, 2_000, 300),
    })), 11_000)
    const target = { threadId: "thread", turnId: "turn-weekly", startedAt: 10_500 }

    const transition = applyQuotaObservation(createInitialState(), weeklyCritical, target, 11_000)

    expect(transition.event).toBeNull()
    expect(transition.state.guard.state).toBe("ARMED")
  })

  it("两个窗口均为 98% used 时只由 5 小时窗口触发一次", () => {
    const bothCritical = normalizeRateLimits(response(snapshot({
      primary: window(98, 8_000, 10_080),
      secondary: window(98, 2_000, 300),
    })), 11_000)
    const target = { threadId: "thread", turnId: "turn-both", startedAt: 10_500 }

    const armed = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    const first = applyQuotaObservation(armed, bothCritical, target, 11_000)
    const second = applyQuotaObservation(first.state, bothCritical, target, 11_100)

    expect(first.event?.target?.turnId).toBe("turn-both")
    expect(second.event).toBeNull()
  })

  it("只有 weekly 窗口时 guard DORMANT、turn ALLOWED 且不触发", () => {
    const weeklyOnly = normalizeRateLimits(response(snapshot({
      primary: window(98, 8_000, 10_080),
      secondary: null,
    })), 11_000)

    const transition = applyQuotaObservation(createInitialState(), weeklyOnly, {
      threadId: "thread",
      turnId: "turn-weekly-only",
      startedAt: 10_500,
    }, 11_000)

    expect(transition.event).toBeNull()
    expect(transition.state.guard.state).toBe("DORMANT")
    expect(transition.admission).toBe("ALLOWED")
  })

  it("5 小时窗口稍后出现时自动 ARMED", () => {
    const weeklyOnly = normalizeRateLimits(response(snapshot({
      primary: window(80, 8_000, 10_080),
      secondary: null,
    })), 10_000)
    let state = applyQuotaObservation(createInitialState(), weeklyOnly, null, 10_000).state

    state = applyQuotaObservation(state, safe(), null, 11_000).state

    expect(state.guard.state).toBe("ARMED")
    expect(state.guard.windowKey).toBe("codex:300:2000")
  })

  it("HANDLED 的 5 小时窗口短暂消失并以同 key 返回时不重复", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    const first = applyQuotaObservation(state, critical(), null, 11_000)
    state = first.state
    const weeklyOnly = normalizeRateLimits(response(snapshot({
      primary: window(80, 8_000, 10_080),
      secondary: null,
    })), 12_000)
    state = applyQuotaObservation(state, weeklyOnly, null, 12_000).state
    expect(state.guard.state).toBe("DORMANT")
    expect(state.guard.thresholdHandled).toBe(true)

    const returned = applyQuotaObservation(state, critical(), {
      threadId: "thread",
      turnId: "turn-after-return",
      startedAt: 13_000,
    }, 13_100)

    expect(returned.event).toBeNull()
    expect(returned.state.guard.state).toBe("HANDLED")
  })

  it("DORMANT 后出现新的 5 小时 windowKey 时重新布防", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    state = applyQuotaObservation(state, critical(), null, 11_000).state
    const weeklyOnly = normalizeRateLimits(response(snapshot({
      primary: window(80, 8_000, 10_080),
      secondary: null,
    })), 12_000)
    state = applyQuotaObservation(state, weeklyOnly, null, 12_000).state

    const newWindow = applyQuotaObservation(state, safe(3_000), null, 13_000)

    expect(newWindow.event).toBeNull()
    expect(newWindow.state.guard.state).toBe("ARMED")
    expect(newWindow.state.guard.windowKey).toBe("codex:300:3000")
  })

  it("weekly resetsAt 改变不得重新布防", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    state = applyQuotaObservation(state, critical(), null, 11_000).state

    const afterWeeklyReset = applyQuotaObservation(state, critical(2_000, 9_000), {
      threadId: "thread",
      turnId: "turn-after-weekly-reset",
      startedAt: 12_000,
    }, 12_100)

    expect(afterWeeklyReset.event).toBeNull()
    expect(afterWeeklyReset.state.guard.state).toBe("HANDLED")
  })

  it("同一窗口只有恢复到高于 5% 才重新布防", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    state = applyQuotaObservation(state, critical(), null, 11_000).state
    const merelyAboveTwo = normalizeRateLimits(response(snapshot({
      primary: window(80, 8_000, 10_080),
      secondary: window(97.5, 2_000, 300),
    })), 12_000)
    state = applyQuotaObservation(state, merelyAboveTwo, null, 12_000).state

    expect(state.guard.state).toBe("HANDLED")

    state = applyQuotaObservation(state, safe(), null, 13_000).state
    expect(state.guard.state).toBe("ARMED")

    const again = applyQuotaObservation(state, critical(), {
      threadId: "thread",
      turnId: "turn-after-recovery",
      startedAt: 14_000,
    }, 14_100)
    expect(again.event?.target?.turnId).toBe("turn-after-recovery")
  })

  it("冷启动已不高于 2% 时不触发，恢复到高于 5% 后再次跨越才触发", () => {
    const coldCritical = normalizeRateLimits(response(snapshot({
      primary: window(98.5, 2_000, 300),
      secondary: window(40, 8_000, 10_080),
    })), 10_000)
    const cold = applyQuotaObservation(createInitialState(), coldCritical, {
      threadId: "thread-cold",
      turnId: "turn-cold",
      startedAt: 9_000,
    }, 10_000)

    expect(cold.event).toBeNull()
    expect(cold.state.guard.state).toBe("ARMED")

    const recovered = applyQuotaObservation(cold.state, safe(), null, 11_000).state
    const crossed = applyQuotaObservation(recovered, critical(), {
      threadId: "thread-after-baseline",
      turnId: "turn-after-baseline",
      startedAt: 11_500,
    }, 12_000)

    expect(crossed.event?.target?.turnId).toBe("turn-after-baseline")
  })

  it("UNKNOWN 不改变同一窗口已经 HANDLED 的事实", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    state = applyQuotaObservation(state, critical(), null, 11_000).state
    const unknown = normalizeRateLimits(response(snapshot({
      primary: window(98, 8_000, 10_080),
      secondary: null,
    })), 12_000)

    state = applyQuotaObservation(state, unknown, null, 12_000).state

    expect(state.guard.state).toBe("DORMANT")
    expect(state.guard.thresholdHandled).toBe(true)
  })

  it("过期且最后剩余不高于 2% 时按固定 active turn 触发一次关闭式事件", () => {
    let state = applyQuotaObservation(createInitialState(), safe(), null, 10_000).state
    state.quota = critical()
    const target = { threadId: "thread-stale", turnId: "turn-stale", startedAt: 11_000 }
    state.activeTurn = target

    const transition = applyStaleQuota(state, target, 200_000, 90_000)

    expect(transition.state.quota?.severity).toBe("UNKNOWN")
    expect(transition.event?.reason).toBe("stale_low_quota")
    expect(transition.event?.target).toEqual(target)
    expect(transition.state.guard.thresholdHandled).toBe(true)
  })
})
