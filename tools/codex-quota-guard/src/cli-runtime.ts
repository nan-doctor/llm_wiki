import type { DoctorResult } from "./doctor.js"
import type { ResumeOptions, RunOptions, StartedTurn } from "./guard/controller.js"
import type { PersistedGuardState, TurnAdmission } from "./guard/state-machine.js"
import { parseCliArgs } from "./cli-args.js"
import { sanitizeDiagnostic } from "./persistence/state-store.js"
import type { RuntimeContext } from "./runtime/runtime-context.js"
import type { InteractiveRunOptions } from "./interactive/session.js"
import type { GuardConfig } from "./persistence/config-store.js"
import type {
  GlobalConfigStore,
  GlobalGuardConfig,
} from "./persistence/global-config-store.js"
import { buildStatusOutput, formatStatusText } from "./ui/status.js"

export interface CliController {
  start(): Promise<void>
  stop(): Promise<void>
  status(): { state: PersistedGuardState; admission: TurnAdmission }
  run(prompt: string, options?: RunOptions): Promise<StartedTurn>
  resume(prompt?: string, options?: ResumeOptions): Promise<StartedTurn | null>
  waitForTurn(started: StartedTurn, maxRuntimeMs?: number): Promise<string>
  waitForIdle(): Promise<void>
  refreshAndHandleQuota(): Promise<void>
}

export interface CliDependencies {
  rootDirectory: string
  resolveRuntimeContext(codexPath: string | undefined): Promise<RuntimeContext>
  createController(context: RuntimeContext): CliController
  createInteractiveSession(context: RuntimeContext): {
    run(options: InteractiveRunOptions): Promise<number>
    stop(reason: string): Promise<void>
  }
  platform: NodeJS.Platform
  globalConfigStore: Pick<GlobalConfigStore, "load" | "update">
  loadProjectConfig(): Promise<GuardConfig | null>
  acquireLock(): Promise<{ release(): Promise<void> }>
  liveCanaryConsent: boolean
  runDoctor(context: RuntimeContext, liveCanary: boolean): Promise<DoctorResult>
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
  if (parsed.command === "config") {
    if (parsed.operation === "show") {
      const [global, project] = await Promise.all([
        dependencies.globalConfigStore.load(),
        dependencies.loadProjectConfig(),
      ])
      const output = {
        global,
        project: {
          codexPath: project?.codexPath ?? null,
          source: project
            ? "project .codex-guard/config.json"
            : "project default",
        },
      }
      dependencies.writeOutput(parsed.json
        ? JSON.stringify(output, null, 2)
        : formatConfig(output.global, output.project))
      return 0
    }
    const updated = await dependencies.globalConfigStore.update((config) => {
      config.defaultRequireProtection = parsed.value
    })
    dependencies.writeOutput(
      `defaultRequireProtection=${String(updated.defaultRequireProtection)}`,
    )
    return 0
  }
  if (parsed.command === "doctor") {
    if (parsed.liveCanary && !dependencies.liveCanaryConsent) {
      throw new Error(
        "live canary 会消耗真实模型额度；必须同时设置 CODEX_QUOTA_GUARD_LIVE_CANARY=I_ACCEPT_MODEL_USAGE",
      )
    }
    const context = await dependencies.resolveRuntimeContext(parsed.codexPath)
    assertLaunchAllowed(context)
    let result: DoctorResult
    try {
      result = await dependencies.runDoctor(context, parsed.liveCanary)
    } catch (error) {
      throw contextualRuntimeError(error, context)
    }
    dependencies.writeOutput(parsed.json ? JSON.stringify(result, null, 2) : formatDoctor(result))
    return result.ok ? 0 : 1
  }

  if (parsed.command === "interactive") {
    const global = await dependencies.globalConfigStore.load()
    const context = await dependencies.resolveRuntimeContext(parsed.codexPath)
    assertLaunchAllowed(context)
    assertInteractiveCapabilities(context, dependencies.platform)
    let lock: Awaited<ReturnType<CliDependencies["acquireLock"]>>
    try {
      lock = await dependencies.acquireLock()
    } catch (error) {
      throw contextualRuntimeError(error, context)
    }
    let session: ReturnType<CliDependencies["createInteractiveSession"]>
    try {
      session = dependencies.createInteractiveSession(context)
    } catch (error) {
      await lock.release()
      throw contextualRuntimeError(error, context)
    }
    try {
      return await session.run({
        tuiArgs: parsed.tuiArgs,
        requireProtection: parsed.requireProtection || global.defaultRequireProtection,
      })
    } catch (error) {
      throw contextualRuntimeError(error, context)
    } finally {
      await session.stop("cli-finally")
      await lock.release()
    }
  }

  const context = await dependencies.resolveRuntimeContext(parsed.codexPath)
  assertLaunchAllowed(context)
  let lock: Awaited<ReturnType<CliDependencies["acquireLock"]>>
  try {
    lock = await dependencies.acquireLock()
  } catch (error) {
    throw contextualRuntimeError(error, context)
  }
  let controller: CliController
  try {
    controller = dependencies.createController(context)
  } catch (error) {
    await lock.release()
    throw contextualRuntimeError(error, context)
  }
  let polling: NodeJS.Timeout | null = null
  try {
    await controller.start()
    if (parsed.command === "status") {
      writeStatus(controller, parsed.json, dependencies, context)
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
        requireGoalControl: parsed.requireGoalControl,
      })
    } else {
      maxRuntimeMs = controller.status().state.limits.maxRuntimeMs ?? undefined
      started = await controller.resume(parsed.prompt, {
        requireGoalControl: parsed.requireGoalControl,
      })
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
    writeStatus(controller, parsed.json, dependencies, context)
    return 0
  } catch (error) {
    throw contextualRuntimeError(error, context, controller.status().state)
  } finally {
    if (polling) clearInterval(polling)
    await controller.stop()
    await lock.release()
  }
}

function formatConfig(
  global: GlobalGuardConfig,
  project: { codexPath: string | null; source: string },
): string {
  return [
    `defaultInteractiveProtection=${String(global.defaultInteractiveProtection)}`,
    `defaultRequireProtection=${String(global.defaultRequireProtection)}`,
    `realCodexExecutable=${global.realCodexExecutable ?? "null"}`,
    `realCodexVersion=${global.realCodexVersion ?? "null"}`,
    `shellIntegration.enabled=${String(global.shellIntegration.enabled)}`,
    `project.codexPath=${project.codexPath ?? "null"}`,
    `project.source=${project.source}`,
  ].join("\n")
}

function contextualRuntimeError(
  error: unknown,
  context: RuntimeContext,
  state?: PersistedGuardState,
): Error {
  const reason = sanitizeDiagnostic(error instanceof Error ? error.message : String(error))
  const executable = context.executable.codexExecutableRealPath
    ?? context.executable.codexExecutable
  const rateLimitsImpact = state?.quota
    ? "已取得额度快照；本错误不表示额度读取失效"
    : "本次失败前未取得可信额度快照或尚未完成验证"
  return new Error([
    `当前 Codex：${executable}`,
    `原因：${reason}`,
    `额度读取影响：${rateLimitsImpact}`,
    `精确 turn interrupt 影响：当前能力=${context.capabilityMatrix.turnInterrupt.status}；本错误不自动否定该能力`,
    `Goal 控制影响：goalControl=${state?.goalControl ?? context.capabilityMatrix.goalPaused.status}`,
    "修正：可使用 --codex-path <绝对路径> 明确选择兼容的 Codex",
  ].join("；"))
}

function assertLaunchAllowed(context: RuntimeContext): void {
  if (context.executable.launchAllowed && context.executable.codexExecutableRealPath) return
  const candidates = context.executable.discoveredCandidates.join("、") || "无"
  throw new Error([
    `发现 Codex 候选但未明确选择：${candidates}`,
    "额度读取不可用；精确 turn interrupt 不可用；Goal 控制不可用",
    "请使用 --codex-path <绝对路径> 明确选择",
  ].join("；"))
}

function assertInteractiveCapabilities(
  context: RuntimeContext,
  platform: NodeJS.Platform,
): void {
  const remote = context.remoteCapabilities
  const required: Array<[boolean, string]> = [
    [remote.remoteTui, "remoteTui"],
    [remote.remoteAuthTokenEnv, "remoteAuthTokenEnv"],
    [remote.appServerStdio, "appServerStdio"],
    [platform === "win32" ? remote.remoteLoopbackWebSocket : remote.remoteUnixSocket,
      platform === "win32" ? "remoteLoopbackWebSocket" : "remoteUnixSocket"],
    [context.schemaCapabilities.rateLimitsRead, "account/rateLimits/read"],
    [context.schemaCapabilities.rateLimitsUpdated, "account/rateLimits/updated"],
    [context.schemaCapabilities.turnStart, "turn/start"],
    [context.schemaCapabilities.turnInterrupt, "turn/interrupt"],
    [context.schemaCapabilities.threadRead, "thread/read"],
  ]
  const missing = required.filter(([available]) => !available).map(([, name]) => name)
  if (missing.length === 0) return
  throw new Error([
    `当前 Codex 缺少安全交互能力：${missing.join("、")}`,
    "不会接管默认 codex，也不会采用双客户端或网页抓取",
    "请保留 codex-guarded 作为安全退化入口",
  ].join("；"))
}

function writeStatus(
  controller: CliController,
  json: boolean,
  dependencies: CliDependencies,
  context: RuntimeContext,
): void {
  const status = controller.status()
  const output = buildStatusOutput(status.state, Date.now(), {
    admission: status.admission,
    runtimeContext: context,
  })
  dependencies.writeOutput(json ? JSON.stringify(output, null, 2) : formatStatusText(output))
}

function formatDoctor(result: DoctorResult): string {
  const lines = [
    `Codex executable: ${result.codexExecutable}`,
    `Executable real path: ${result.executableRealPath ?? "UNKNOWN"}`,
    `Selection source: ${result.executableSelectionSource}`,
    `Codex version: ${result.codexVersion ?? "UNKNOWN"} (${result.protocol.versionStatus.toUpperCase()})`,
    `Protocol fingerprint: ${result.protocolFingerprint ?? "UNKNOWN"}`,
    `compatibility basis: ${result.protocol.compatibilityBasis}`,
    `app-server handshake: ${result.appServerHandshake ? "OK" : "FAILED"}`,
    `rate limits read: ${result.rateLimitsRead ? "OK" : "FAILED"}`,
    `five-hour protection: ${result.fiveHourProtectionAvailable ? "AVAILABLE" : "UNAVAILABLE"}`,
    `remote TUI: ${availability(result.remoteCapabilities.remoteTui)}`,
    `remote auth token env: ${availability(result.remoteCapabilities.remoteAuthTokenEnv)}`,
    `remote Unix socket: ${availability(result.remoteCapabilities.remoteUnixSocket)}`,
    `remote loopback WebSocket: ${availability(result.remoteCapabilities.remoteLoopbackWebSocket)}`,
    `App Server stdio: ${availability(result.remoteCapabilities.appServerStdio)}`,
    `Rate limits: ${result.capabilityMatrix.rateLimitsRead.status}`,
    `Turn interrupt: ${result.capabilityMatrix.turnInterrupt.status}`,
    `Thread read: ${result.capabilityMatrix.threadRead.status}`,
    `Goal pause/resume: ${combinedCapabilityStatus(
      result.capabilityMatrix.goalPaused.status,
      result.capabilityMatrix.goalResume.status,
    )}`,
    `Goal resume: ${result.capabilityMatrix.goalResume.status}`,
    `Server request handling: ${result.capabilityMatrix.serverRequestHandling.status}`,
    `account/rateLimits/read: ${formatCapability(result.capabilityMatrix.rateLimitsRead)}`,
    `account/rateLimits/updated: ${formatCapability(result.capabilityMatrix.rateLimitsUpdated)}`,
    `turn/start: ${formatCapability(result.capabilityMatrix.turnStart)}`,
    `turn/interrupt: ${formatCapability(result.capabilityMatrix.turnInterrupt)}`,
    `thread/read: ${formatCapability(result.capabilityMatrix.threadRead)}`,
    `Goal get: ${formatCapability(result.capabilityMatrix.goalGet)}`,
    `Goal set: ${formatCapability(result.capabilityMatrix.goalSet)}`,
    `Goal paused: ${formatCapability(result.capabilityMatrix.goalPaused)}`,
    `Goal resume: ${formatCapability(result.capabilityMatrix.goalResume)}`,
    `background terminal clean: ${formatCapability(result.capabilityMatrix.backgroundTerminalsClean)}`,
    `server request handling: ${formatCapability(result.capabilityMatrix.serverRequestHandling)}`,
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

function availability(value: boolean): string {
  return value ? "AVAILABLE" : "UNAVAILABLE"
}

function combinedCapabilityStatus(
  first: DoctorResult["capabilityMatrix"]["goalPaused"]["status"],
  second: DoctorResult["capabilityMatrix"]["goalResume"]["status"],
): string {
  if (first === "failed" || second === "failed") return "failed"
  if (first === "degraded" || second === "degraded") return "degraded"
  if (first === "unavailable" || second === "unavailable") return "unavailable"
  if (first === "runtimeVerified" && second === "runtimeVerified") return "runtimeVerified"
  return "schemaDetected"
}

function formatHelp(): string {
  return `Codex Quota Guard

用法：
  codex-quota-guard config show [--json]
  codex-quota-guard config set default-require-protection true|false
  codex-quota-guard interactive [--require-protection] [--codex-path <绝对路径>]
                                [-- <原生 TUI 参数>]
  codex-quota-guard status [--json]
  codex-quota-guard run <提示> [--thread <id>] [--goal <目标>] [--token-budget <数量>]
                        [--max-runtime <时长>] [--max-turns <数量>]
                        [--require-protection] [--require-goal-control] [--json]
  codex-quota-guard resume [提示] [--require-goal-control] [--json]
  codex-quota-guard doctor [--live-canary] [--json]

说明：
  interactive             无需命令行提示；任务提示请在 TUI 内输入
  --codex-path <绝对路径>  为本次命令明确选择 Codex，不静默回退
  --require-protection  仅当 5 小时保护窗口可用时允许本次 run
  --require-goal-control  仅当 Goal pause/resume 可运行时允许启动 turn
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
