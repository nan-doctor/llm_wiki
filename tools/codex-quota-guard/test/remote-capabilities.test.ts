import { describe, expect, it } from "vitest"
import { inspectRemoteCapabilities } from "../src/runtime/remote-capabilities.js"

describe("inspectRemoteCapabilities", () => {
  it("从当前 TUI 与 App Server help 提取全部本地 remote 能力", () => {
    expect(inspectRemoteCapabilities({
      tuiHelp: [
        "--remote <ADDR> ws://IP:PORT unix://PATH",
        "--remote-auth-token-env <ENV_VAR>",
      ].join("\n"),
      appServerHelp: "--listen <URI> stdio:// unix://PATH ws://IP:PORT",
    })).toEqual({
      remoteTui: true,
      remoteAuthTokenEnv: true,
      remoteUnixSocket: true,
      remoteLoopbackWebSocket: true,
      appServerStdio: true,
    })
  })

  it.each([
    ["remoteTui", "--remote <ADDR>"],
    ["remoteAuthTokenEnv", "--remote-auth-token-env <ENV_VAR>"],
    ["remoteUnixSocket", "unix://PATH"],
    ["remoteLoopbackWebSocket", "ws://IP:PORT"],
  ] as const)("TUI help 缺少 %s 证据时只关闭该能力", (key, fragment) => {
    const full = "--remote <ADDR> --remote-auth-token-env <ENV_VAR> unix://PATH ws://IP:PORT"
    const capabilities = inspectRemoteCapabilities({
      tuiHelp: full.replace(fragment, ""),
      appServerHelp: "--listen <URI> stdio:// unix://PATH ws://IP:PORT",
    })

    expect(capabilities[key]).toBe(false)
  })

  it("App Server help 缺少 stdio:// 时不宣称稳定上游可用", () => {
    const capabilities = inspectRemoteCapabilities({
      tuiHelp: "--remote <ADDR> --remote-auth-token-env <ENV_VAR> unix://PATH ws://IP:PORT",
      appServerHelp: "--listen <URI> unix://PATH ws://IP:PORT",
    })

    expect(capabilities.appServerStdio).toBe(false)
  })
})
