import { describe, expect, it } from "vitest"
import { parseCliArgs } from "../src/cli-args.js"

describe("parseCliArgs", () => {
  it("解析仓库外安装验证所需的 --help", () => {
    expect(parseCliArgs(["--help"])).toEqual({ command: "help" })
    expect(parseCliArgs(["help"])).toEqual({ command: "help" })
  })

  it("doctor 只有显式参数才选择 live canary", () => {
    expect(parseCliArgs(["doctor", "--live-canary", "--json"])).toEqual({
      command: "doctor",
      json: true,
      liveCanary: true,
    })
    expect(parseCliArgs(["doctor"])).toEqual({
      command: "doctor",
      json: false,
      liveCanary: false,
    })
  })

  it("解析 run 的单轮参数", () => {
    expect(parseCliArgs([
      "run",
      "检查当前仓库",
      "--thread",
      "thread-1",
      "--token-budget",
      "12000",
      "--max-runtime",
      "5m",
      "--max-turns",
      "3",
      "--require-protection",
      "--json",
    ])).toEqual({
      command: "run",
      prompt: "检查当前仓库",
      threadId: "thread-1",
      goal: undefined,
      tokenBudget: 12_000,
      maxRuntimeMs: 300_000,
      maxTurns: 3,
      requireProtection: true,
      json: true,
    })
  })

  it("run 默认不要求 5 小时保护可用", () => {
    expect(parseCliArgs(["run", "默认任务"])).toMatchObject({
      command: "run",
      requireProtection: false,
    })
  })

  it("resume 允许省略提示", () => {
    expect(parseCliArgs(["resume", "--json"])).toEqual({
      command: "resume",
      prompt: undefined,
      json: true,
    })
  })

  it("不提供 --small 参数", () => {
    expect(() => parseCliArgs(["run", "任务", "--small"])).toThrow("未知参数：--small")
  })
})
