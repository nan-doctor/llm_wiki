import type { GuardController } from "../guard/controller.js"
import type { RuntimeContext } from "../runtime/runtime-context.js"
import {
  buildStatusOutput,
  formatStatusText,
  type GuardStatusOutput,
} from "../ui/status.js"

export interface InteractivePreflightOptions {
  requireProtection: boolean
  runtimeContext: RuntimeContext
  now?: () => number
}

export interface InteractivePreflightResult {
  status: GuardStatusOutput
  text: string
}

export async function runInteractivePreflight(
  controller: GuardController,
  options: InteractivePreflightOptions,
): Promise<InteractivePreflightResult> {
  await controller.start()
  try {
    const current = controller.status()
    const status = buildStatusOutput(current.state, (options.now ?? Date.now)(), {
      admission: current.admission,
      runtimeContext: options.runtimeContext,
    })
    if (options.requireProtection && !status.protectedWindow.available) {
      throw new Error("5 小时保护当前不可用，严格交互模式拒绝启动")
    }
    if (options.requireProtection && status.protectedWindow.awaitingBaseline) {
      throw new Error("5 小时保护仍在等待安全基线，严格交互模式拒绝启动")
    }
    const text = [
      "Codex Quota Guard: active",
      `Codex executable: ${options.runtimeContext.executable.codexExecutableRealPath
        ?? options.runtimeContext.executable.codexExecutable}`,
      formatStatusText(status),
      "weekly: informational only",
      "Bypass: codex-raw",
    ].join("\n")
    return { status, text }
  } finally {
    await controller.stop()
  }
}
