import { spawn } from "node:child_process"
import os from "node:os"

export interface RunExactChildOptions {
  cwd?: string
  environment?: NodeJS.ProcessEnv
}

export function runExactChild(
  executable: string,
  args: string[],
  options: RunExactChildOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    })
    let settled = false
    const forwardedSignals: NodeJS.Signals[] = process.platform === "win32"
      ? ["SIGINT", "SIGTERM"]
      : ["SIGINT", "SIGTERM", "SIGHUP"]
    const handlers = new Map<NodeJS.Signals, () => void>()
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
      handlers.clear()
    }
    for (const signal of forwardedSignals) {
      const handler = () => {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal)
      }
      handlers.set(signal, handler)
      process.on(signal, handler)
    }
    child.once("error", (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      cleanup()
      if (code !== null) {
        resolve(code)
        return
      }
      resolve(signalExitCode(signal))
    })
  })
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1
  const number = os.constants.signals[signal]
  return typeof number === "number" ? 128 + number : 1
}
