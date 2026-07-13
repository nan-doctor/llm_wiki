import path from "node:path"
import type { SupportedShell } from "../persistence/global-config-store.js"

export interface CurrentShell {
  shell: SupportedShell
  profilePath: string
}

export interface DetectCurrentShellOptions {
  platform: NodeJS.Platform
  shellPath: string
  home: string
  parentProcessName?: string
  powershellProfilePath?: string
}

export async function detectCurrentShell(
  options: DetectCurrentShellOptions,
): Promise<CurrentShell> {
  if (options.platform === "win32") return detectPowerShell(options)

  const loginShell = normalizeUnixShell(options.shellPath)
  const parentShell = options.parentProcessName
    ? normalizeUnixShell(options.parentProcessName)
    : null
  if (!loginShell) {
    throw new Error(`不支持的当前 shell：${options.shellPath || "(空)"}`)
  }
  if (options.parentProcessName && !parentShell) {
    throw new Error(`不支持的当前 shell：${options.parentProcessName}`)
  }
  if (parentShell && parentShell !== loginShell) {
    throw new Error(
      `无法证明当前 shell：SHELL=${loginShell}，父进程=${parentShell}`,
    )
  }

  const profileName = loginShell === "zsh"
    ? ".zshrc"
    : options.platform === "darwin" ? ".bash_profile" : ".bashrc"
  return {
    shell: loginShell,
    profilePath: path.posix.join(options.home, profileName),
  }
}

function detectPowerShell(options: DetectCurrentShellOptions): CurrentShell {
  const parent = path.win32.basename(options.parentProcessName ?? "").toLowerCase()
  if (parent !== "pwsh.exe" && parent !== "powershell.exe") {
    throw new Error(`不支持的当前 shell：${options.parentProcessName ?? "(空)"}`)
  }
  if (!options.powershellProfilePath) {
    throw new Error("不支持当前 PowerShell：无法取得当前用户 profile 路径")
  }
  return { shell: "powershell", profilePath: options.powershellProfilePath }
}

function normalizeUnixShell(value: string): "zsh" | "bash" | null {
  const name = path.posix.basename(value).toLowerCase()
  if (name === "zsh" || name === "bash") return name
  return null
}
