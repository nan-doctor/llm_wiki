import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runExactChild } from "../src/process/run-child.js"
import { routeShim } from "../src/shell/router.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })))
})

function environment(): Record<string, string | undefined> {
  return {}
}

describe("routeShim", () => {
  it("无参数和原生交互 flags 进入受保护 TUI", () => {
    expect(routeShim("codex", [], environment())).toEqual({
      kind: "interactive",
      tuiArgs: [],
    })
    expect(routeShim("codex", ["--model", "gpt-5"], environment())).toEqual({
      kind: "interactive",
      tuiArgs: ["--model", "gpt-5"],
    })
  })

  it("codex-raw、raw 子命令和单次环境旁路均原样转发", () => {
    expect(routeShim("codex", ["raw", "exec", "x"], environment())).toEqual({
      kind: "raw",
      args: ["exec", "x"],
      reason: "explicit-raw",
    })
    expect(routeShim("codex-raw", ["--version"], environment())).toEqual({
      kind: "raw",
      args: ["--version"],
      reason: "codex-raw",
    })
    const env = { CODEX_QUOTA_GUARD_BYPASS: "1", KEEP: "yes" }
    expect(routeShim("codex", ["login"], env)).toEqual({
      kind: "raw",
      args: ["login"],
      reason: "bypass",
    })
    expect(env).toEqual({ CODEX_QUOTA_GUARD_BYPASS: "1", KEEP: "yes" })
  })

  it.each([
    "login",
    "logout",
    "mcp",
    "app-server",
    "completion",
    "plugin",
    "mcp-server",
    "remote-control",
    "update",
    "doctor",
    "features",
  ])("固定白名单管理命令透明转发：%s", (command) => {
    expect(routeShim("codex", [command, "arg"], environment())).toEqual({
      kind: "management",
      args: [command, "arg"],
    })
  })

  it("version、exec 和未知子命令不静默旁路", () => {
    expect(routeShim("codex", ["--version"], environment())).toEqual({ kind: "version" })
    expect(routeShim("codex", ["exec", "x"], environment())).toEqual({
      kind: "reject-exec",
    })
    expect(routeShim("codex", ["future-command"], environment())).toEqual({
      kind: "unknown",
      args: ["future-command"],
    })
  })

  it.each([
    ["--remote", "unix:///tmp/unsafe.sock"],
    ["--remote=ws://127.0.0.1:9"],
    ["--remote-auth-token-env", "TOKEN"],
    ["--remote-auth-token-env=TOKEN"],
  ])("交互路由拒绝覆盖 Guard remote 参数：%s", (...args) => {
    expect(routeShim("codex", args, environment())).toMatchObject({
      kind: "reject",
      message: expect.stringContaining("remote"),
    })
  })
})

describe("runExactChild", () => {
  it("不经过 shell 并保持空格参数边界和退出码", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-child-"))
    roots.push(root)
    const transcript = path.join(root, "args.json")
    const script = [
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
      "process.exit(37)",
    ].join(";")

    const code = await runExactChild(process.execPath, [
      "-e",
      script,
      transcript,
      "path with spaces",
      "$(not-a-shell)",
    ])

    expect(code).toBe(37)
    expect(JSON.parse(await readFile(transcript, "utf8"))).toEqual([
      "path with spaces",
      "$(not-a-shell)",
    ])
  })

  it.runIf(process.platform !== "win32")("把信号退出映射为 128+signal", async () => {
    await expect(runExactChild(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ])).resolves.toBe(143)
  })

  it("启动失败明确拒绝而不伪装为成功", async () => {
    await expect(runExactChild("/definitely/missing/codex", []))
      .rejects.toThrow()
  })
})
