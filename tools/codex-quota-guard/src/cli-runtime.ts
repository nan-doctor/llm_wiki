import type { DoctorResult } from "./doctor.js"
import type { RunOptions, StartedTurn } from "./guard/controller.js"
import type { PersistedGuardState, TurnAdmission } from "./guard/state-machine.js"
import { parseCliArgs } from "./cli-args.js"
import { buildStatusOutput, formatStatusText } from "./ui/status.js"

export interface CliController {
  start(): Promise<void>
  stop(): Promise<void>
  status(): { state: PersistedGuardState; admission: TurnAdmission }
  run(prompt: string, options?: RunOptions): Promise<StartedTurn>
  resume(prompt?: string): Promise<StartedTurn | null>
  waitForTurn(started: StartedTurn, maxRuntimeMs?: number): Promise<string>
  waitForIdle(): Promise<void>
  refreshAndHandleQuota(): Promise<void>
}

export interface CliDependencies {
  rootDirectory: string
  createController(): CliController
  acquireLock(): Promise<{ release(): Promise<void> }>
  liveCanaryConsent: boolean
  runDoctor(liveCanary: boolean): Promise<DoctorResult>
  writeOutput(value: string): void
}

export async function executeCli(
  args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseCliArgs(args)
  if (parsed.command === "help") {
    dependencies.writeOutput(formatHelp())
    return 0
  }
  if (parsed.command === "doctor") {
    if (parsed.liveCanary && !dependencies.liveCanaryConsent) {
      throw new Error(
        "live canary 会消耗真实模型额度；必须同时设置 CODEX_QUOTA_GUARD_LIVE_CANARY=I_ACCEPT_MODEL_USAGE",
      )
    }
    const result = await dependencies.runDoctor(parsed.liveCanary)
    dependencies.writeOutput(parsed.json ? JSON.stringify(result, null, 2) : formatDoctor(result))
    return result.ok ? 0 : 1
  }

  const lock = await dependencies.acquireLock()
  const controller = dependencies.createController()
  let polling: NodeJS.Timeout | null = null
  try {
    await controller.start()
    if (parsed.command === "status") {
      writeStatus(controller, parsed.json, dependencies)
      return 0
    }

    polling = setInterval(() => {
      void controller.refreshAndHandleQuota().catch(() => undefined)
    }, 30_000)
    polling.unref()

    let started: StartedTurn | null
    let maxRuntimeMs: number | undefined
    if (parsed.command === "run") {
      maxRuntimeMs = parsed.maxRuntimeMs
      started = await controller.run(parsed.prompt, {
        threadId: parsed.threadId,
        goal: parsed.goal,
        tokenBudget: parsed.tokenBudget,
        maxRuntimeMs: parsed.maxRuntimeMs,
        maxTurns: parsed.maxTurns,
        requireProtection: parsed.requireProtection,
      })
    } else {
      maxRuntimeMs = controller.status().state.limits.maxRuntimeMs ?? undefined
      started = await controller.resume(parsed.prompt)
    }

    if (started) {
      if (!parsed.json) {
        dependencies.writeOutput(`thread: ${started.threadId} · turn: ${started.turnId}`)
      }
      const turnStatus = await controller.waitForTurn(started, maxRuntimeMs)
      await controller.waitForIdle()
      if (turnStatus === "failed") {
        const errors = controller.status().state.errors
        const detail = [...errors].reverse().find((error) => error.startsWith("turn 失败："))
        throw new Error(detail
          ? detail.replace(/^turn 失败：/, "turn 执行失败：")
          : "turn 执行失败")
      }
    }
    writeStatus(controller, parsed.json, dependencies)
    return 0
  } finally {
    if (polling) clearInterval(polling)
    await controller.stop()
    await lock.release()
  }
}

function writeStatus(
  controller: CliController,
  json: boolean,
  dependencies: CliDependencies,
): void {
  const status = controller.status()
  const output = buildStatusOutput(status.state, Date.now(), {
    admission: status.admission,
  })
  dependencies.writeOutput(json ? JSON.stringify(output, null, 2) : formatStatusText(output))
}

function formatDoctor(result: DoctorResult): string {
  const lines = [
    `Codex version: ${result.codexVersion ?? "UNKNOWN"} (${result.protocol.versionStatus.toUpperCase()})`,
    `compatibility basis: ${result.protocol.compatibilityBasis}`,
    `app-server handshake: ${result.appServerHandshake ? "OK" : "FAILED"}`,
    `rate limits read: ${result.rateLimitsRead ? "OK" : "FAILED"}`,
    `five-hour protection: ${result.fiveHourProtectionAvailable ? "AVAILABLE" : "UNAVAILABLE"}`,
    `account/rateLimits/read: ${formatCapability(result.capabilityMatrix.rateLimitsRead)}`,
    `account/rateLimits/updated: ${formatCapability(result.capabilityMatrix.rateLimitsUpdated)}`,
    `turn/start: ${formatCapability(result.capabilityMatrix.turnStart)}`,
    `turn/interrupt: ${formatCapability(result.capabilityMatrix.turnInterrupt)}`,
    `Goal get: ${formatCapability(result.capabilityMatrix.goalGet)}`,
    `Goal set: ${formatCapability(result.capabilityMatrix.goalSet)}`,
    `Goal paused: ${formatCapability(result.capabilityMatrix.goalPaused)}`,
    `background terminal clean: ${formatCapability(result.capabilityMatrix.backgroundTerminalsClean)}`,
    `overall: ${result.status.toUpperCase()}`,
  ]
  if (result.liveCanary) {
    lines.push(
      `live canary: ${result.liveCanary.succeeded ? "PASSED" : "FAILED"} · thread=${result.liveCanary.threadId ?? "unknown"} · turn=${result.liveCanary.turnId ?? "unknown"}`,
    )
  }
  for (const warning of result.warnings) lines.push(`warning: ${warning}`)
  for (const error of result.errors) lines.push(`error: ${error}`)
  return lines.join("\n")
}

function formatHelp(): string {
  return `Codex Quota Guard

用法：
  codex-quota-guard status [--json]
  codex-quota-guard run <提示> [--thread <id>] [--goal <目标>] [--token-budget <数量>]
                        [--max-runtime <时长>] [--max-turns <数量>]
                        [--require-protection] [--json]
  codex-quota-guard resume [提示] [--json]
  codex-quota-guard doctor [--live-canary] [--json]

说明：
  --require-protection  仅当 5 小时保护窗口可用时允许本次 run
  --live-canary         执行一次双重确认的极小真实 turn 验收
  --help, -h            显示本帮助且不启动 App Server`
}

function formatCapability(evidence: {
  schemaDetected: boolean
  runtimeVerified: boolean | null
}): string {
  const schema = evidence.schemaDetected ? "DETECTED" : "MISSING"
  const runtime = evidence.runtimeVerified === null
    ? "NOT_TESTED"
    : evidence.runtimeVerified ? "VERIFIED" : "FAILED"
  return `schema=${schema} · runtime=${runtime}`
}
