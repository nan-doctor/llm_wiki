import { describe, expect, it } from "vitest"
import { detectCurrentShell } from "../src/shell/current-shell.js"

describe("detectCurrentShell", () => {
  it.each([
    ["darwin", "/bin/zsh", "zsh", ".zshrc"],
    ["darwin", "/bin/bash", "bash", ".bash_profile"],
    ["linux", "/usr/bin/zsh", "zsh", ".zshrc"],
    ["linux", "/bin/bash", "bash", ".bashrc"],
  ] as const)("%s 只选择当前 %s", async (platform, shellPath, shell, profile) => {
    await expect(detectCurrentShell({
      platform,
      shellPath,
      home: "/home/me",
    })).resolves.toEqual({ shell, profilePath: `/home/me/${profile}` })
  })

  it("父进程与 SHELL 冲突时拒绝猜测", async () => {
    await expect(detectCurrentShell({
      platform: "darwin",
      shellPath: "/bin/zsh",
      parentProcessName: "bash",
      home: "/home/me",
    })).rejects.toThrow("无法证明当前 shell")
  })

  it.each(["fish", "cmd.exe", ""])("拒绝不支持的当前 shell：%s", async (name) => {
    await expect(detectCurrentShell({
      platform: name === "cmd.exe" ? "win32" : "linux",
      shellPath: name ? `/bin/${name}` : "",
      parentProcessName: name || undefined,
      home: "/home/me",
    })).rejects.toThrow("不支持")
  })

  it.each(["pwsh.exe", "powershell.exe"])("Windows 只接受已证明的 %s", async (parent) => {
    await expect(detectCurrentShell({
      platform: "win32",
      shellPath: "",
      parentProcessName: parent,
      home: "C:\\Users\\me",
      powershellProfilePath: "C:\\Users\\me\\Documents\\PowerShell\\profile.ps1",
    })).resolves.toEqual({
      shell: "powershell",
      profilePath: "C:\\Users\\me\\Documents\\PowerShell\\profile.ps1",
    })
  })
})
