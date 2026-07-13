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
      codexPath: undefined,
    })
    expect(parseCliArgs(["doctor"])).toEqual({
      command: "doctor",
      json: false,
      liveCanary: false,
      codexPath: undefined,
    })
  })

  it("interactive 无需提示并以 -- 分隔原生 TUI 参数", () => {
    expect(parseCliArgs(["interactive"])).toEqual({
      command: "interactive",
      codexPath: undefined,
      requireProtection: false,
      tuiArgs: [],
    })
    expect(parseCliArgs([
      "interactive",
      "--require-protection",
      "--codex-path",
      "/real/codex",
      "--",
      "--model",
      "gpt-5",
    ])).toEqual({
      command: "interactive",
      codexPath: "/real/codex",
      requireProtection: true,
      tuiArgs: ["--model", "gpt-5"],
    })
  })

  it.each([
    ["--remote", "unix:///tmp/other.sock"],
    ["--remote=ws://127.0.0.1:1"],
    ["--remote-auth-token-env", "OTHER_TOKEN"],
    ["--remote-auth-token-env=OTHER_TOKEN"],
  ])("interactive 拒绝用户覆盖 Guard 独占的 remote 参数：%s", (...remoteArgs) => {
    expect(() => parseCliArgs(["interactive", "--", ...remoteArgs]))
      .toThrow("remote 参数由 Codex Quota Guard 独占")
  })

  it("interactive 不把 -- 分界前的位置文本当成任务提示", () => {
    expect(() => parseCliArgs(["interactive", "检查仓库"]))
      .toThrow("任务提示请在 TUI 内输入")
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
      requireGoalControl: false,
      codexPath: undefined,
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
      requireGoalControl: false,
      codexPath: undefined,
      json: true,
    })
  })

  it("四个命令都解析包含空格的 --codex-path", () => {
    const codexPath = "/路径 含空格/codex"

    expect(parseCliArgs(["status", "--codex-path", codexPath])).toMatchObject({
      command: "status",
      codexPath,
    })
    expect(parseCliArgs(["doctor", "--codex-path", codexPath])).toMatchObject({
      command: "doctor",
      codexPath,
    })
    expect(parseCliArgs(["run", "执行", "--codex-path", codexPath])).toMatchObject({
      command: "run",
      codexPath,
    })
    expect(parseCliArgs(["resume", "--codex-path", codexPath])).toMatchObject({
      command: "resume",
      codexPath,
    })
  })

  it("run 和 resume 解析严格 Goal 控制", () => {
    expect(parseCliArgs(["run", "执行", "--require-goal-control"])).toMatchObject({
      command: "run",
      requireGoalControl: true,
    })
    expect(parseCliArgs(["resume", "继续", "--require-goal-control"])).toMatchObject({
      command: "resume",
      requireGoalControl: true,
    })
  })

  it("不提供 --small 参数", () => {
    expect(() => parseCliArgs(["run", "任务", "--small"])).toThrow("未知参数：--small")
  })
})
