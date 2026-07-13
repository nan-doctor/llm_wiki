import path from "node:path"
import type { DoctorResult } from "./doctor.js"
import type { ResumeOptions, RunOptions, StartedTurn } from "./guard/controller.js"
import type { PersistedGuardState, TurnAdmission } from "./guard/state-machine.js"
import { parseCliArgs } from "./cli-args.js"
import { sanitizeDiagnostic } from "./persistence/state-store.js"
import type { RuntimeContext } from "./runtime/runtime-context.js"
import type { ResolvedCodexExecutable } from "./runtime/types.js"
import type { InteractiveRunOptions } from "./interactive/session.js"
import type { ShellOperationResult } from "./shell/installer.js"
import { routeShim } from "./shell/router.js"
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

export interface CliShellInstaller {
  install(context: RuntimeContext): Promise<ShellOperationResult>
  status(): Promise<ShellOperationResult>
  uninstall(): Promise<ShellOperationResult>
}

export interface CliShimDependencies {
  environment: NodeJS.ProcessEnv
  readonly isTTY: boolean
  guardVersion: string
  cliEntryPath: string
  resolveSavedExecutable(codexPath: string): Promise<ResolvedCodexExecutable>
  runChild(executable: string, args: string[]): Promise<number>
  promptUnknown(args: string[]): Promise<string>
  writeError(value: string): void
}

export interface CliDependencies {
  rootDirectory: string
  resolveRuntimeContext(codexPath: string | undefined): Promise<RuntimeContext>
  createController(context: RuntimeContext): CliController
  createInteractiveSession(context: RuntimeContext): {
    run(options: InteractiveRunOptions): Promise<number>
    stop(reason: string): Promise<void>
  }
  createShellInstaller(): CliShellInstaller
  shim: CliShimDependencies
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
  if (parsed.command === "__shim") {
    return await executeShim(parsed, dependencies)
  }
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
  if (parsed.command === "shell") {
    const installer = dependencies.createShellInstaller()
    let result: ShellOperationResult
    if (parsed.operation === "install") {
      const global = await dependencies.globalConfigStore.load()
      const codexPath = parsed.codexPath
        ?? (global.shellIntegration.enabled
          ? global.realCodexExecutable ?? undefined
          : undefined)
      result = await installer.install(await dependencies.resolveRuntimeContext(codexPath))
    } else {
      result = parsed.operation === "status"
        ? await installer.status()
        : await installer.uninstall()
    }
    dependencies.writeOutput(
      parsed.operation === "status" && parsed.json
        ? JSON.stringify(result, null, 2)
        : formatShellResult(result),
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
    return await executeInteractiveSession(context, {
      tuiArgs: parsed.tuiArgs,
      requireProtection: parsed.requireProtection || global.defaultRequireProtection,
    }, dependencies)
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

async function executeShim(
  parsed: Extract<ReturnType<typeof parseCliArgs>, { command: "__shim" }>,
  dependencies: CliDependencies,
): Promise<number> {
  const config = await dependencies.globalConfigStore.load()
  const savedPath = requireSavedCodex(config, dependencies.platform)
  if (parsed.entry === "identity") {
    const resolved = await resolveAndValidateSavedCodex(savedPath, config, dependencies)
    dependencies.writeOutput(resolved.codexExecutableRealPath!)
    return 0
  }

  const route = routeShim(parsed.entry, parsed.args, dependencies.shim.environment)
  if (route.kind === "interactive") {
    if (!config.defaultInteractiveProtection) {
      await resolveAndValidateSavedCodex(savedPath, config, dependencies)
      dependencies.shim.writeError([
        "默认交互保护已关闭，拒绝把 codex 静默转为原始调用。",
        "需要明确旁路时请使用 codex-raw。",
      ].join("\n"))
      return 2
    }
    assertSavedPathNotRecursive(savedPath, config, dependencies)
    const context = await dependencies.resolveRuntimeContext(savedPath)
    validateResolvedCodex(context.executable, savedPath, config, dependencies)
    return await executeInteractiveSession(context, {
      tuiArgs: route.tuiArgs,
      requireProtection: config.defaultRequireProtection,
    }, dependencies, async () => {
      await dependencies.globalConfigStore.update((latest) => {
        if (latest.realCodexExecutable !== savedPath) {
          throw new Error("shell 配置在启动期间发生变化，拒绝更新版本身份")
        }
        latest.realCodexVersion = context.executable.codexVersion
      })
    })
  }

  const resolved = await resolveAndValidateSavedCodex(savedPath, config, dependencies)
  const executable = resolved.codexExecutableRealPath!
  if (route.kind === "raw") {
    if (dependencies.shim.isTTY) {
      dependencies.shim.writeError(
        "警告：本次调用未受额度保护；不会改变现有 HANDLED 记录。",
      )
    }
    return await dependencies.shim.runChild(executable, route.args)
  }
  if (route.kind === "management") {
    dependencies.shim.writeError(
      `Codex Quota Guard：正在执行原生管理命令 ${route.args[0]}。`,
    )
    return await dependencies.shim.runChild(executable, route.args)
  }
  if (route.kind === "version") {
    dependencies.writeOutput([
      `Codex Quota Guard wrapper ${dependencies.shim.guardVersion}`,
      `真实 Codex：${executable}`,
      `保存版本：${config.realCodexVersion ?? "UNKNOWN"}`,
      `实测版本：${resolved.codexVersion ?? "UNKNOWN"}`,
      "纯原始版本：codex-raw --version",
    ].join("\n"))
    return 0
  }
  if (route.kind === "reject-exec") {
    dependencies.shim.writeError([
      "当前 wrapper 尚不能完整保持 codex exec 的参数和退出语义，已拒绝执行。",
      "受保护执行请使用：codex-quota-guard run <提示>",
      "明确无保护执行请使用：codex-raw exec ...",
    ].join("\n"))
    return 2
  }
  if (route.kind === "reject") {
    dependencies.shim.writeError(route.message)
    return 2
  }

  dependencies.shim.writeError([
    `未识别的 Codex 子命令：${JSON.stringify(route.args)}`,
    "不会把它当作任务提示词，也不会静默绕过保护。",
  ].join("\n"))
  if (!dependencies.shim.isTTY) return 2
  const choice = await dependencies.shim.promptUnknown(route.args)
  if (choice !== "raw") {
    dependencies.shim.writeError("已取消；如需受保护任务，请直接运行 codex 并在 TUI 内输入。")
    return 2
  }
  dependencies.shim.writeError("警告：用户已明确选择 raw，本次调用未受额度保护。")
  return await dependencies.shim.runChild(executable, route.args)
}

async function executeInteractiveSession(
  context: RuntimeContext,
  options: InteractiveRunOptions,
  dependencies: CliDependencies,
  afterValidation?: () => Promise<void>,
): Promise<number> {
  assertLaunchAllowed(context)
  assertInteractiveCapabilities(context, dependencies.platform)
  await afterValidation?.()
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
    return await session.run(options)
  } catch (error) {
    throw contextualRuntimeError(error, context)
  } finally {
    await session.stop("cli-finally")
    await lock.release()
  }
}

function requireSavedCodex(
  config: GlobalGuardConfig,
  platform: NodeJS.Platform,
): string {
  if (!config.shellIntegration.enabled || !config.realCodexExecutable) {
    throw new Error("默认 Codex shell 集成未安装或缺少真实路径；请重新运行 shell install")
  }
  const platformPath = platform === "win32" ? path.win32 : path.posix
  if (!platformPath.isAbsolute(config.realCodexExecutable)) {
    throw new Error("保存的真实 Codex 不是绝对路径；请运行 doctor 后重新安装")
  }
  return config.realCodexExecutable
}

async function resolveAndValidateSavedCodex(
  savedPath: string,
  config: GlobalGuardConfig,
  dependencies: CliDependencies,
): Promise<ResolvedCodexExecutable> {
  assertSavedPathNotRecursive(savedPath, config, dependencies)
  let resolved: ResolvedCodexExecutable
  try {
    resolved = await dependencies.shim.resolveSavedExecutable(savedPath)
  } catch (error) {
    const message = sanitizeDiagnostic(error instanceof Error ? error.message : String(error))
    throw new Error(`保存的真实 Codex 不可用：${message}；请运行 codex-quota-guard doctor`)
  }
  validateResolvedCodex(resolved, savedPath, config, dependencies)
  return resolved
}

function assertSavedPathNotRecursive(
  savedPath: string,
  config: GlobalGuardConfig,
  dependencies: CliDependencies,
): void {
  const forbidden = forbiddenGuardPaths(config, dependencies)
  if (forbidden.some((candidate) => samePlatformPath(
    savedPath,
    candidate,
    dependencies.platform,
  ))) {
    throw new Error("保存的真实 Codex 指向 Guard 或 shim，拒绝递归；请运行 doctor")
  }
}

function validateResolvedCodex(
  resolved: ResolvedCodexExecutable,
  savedPath: string,
  config: GlobalGuardConfig,
  dependencies: CliDependencies,
): void {
  const realPath = resolved.codexExecutableRealPath
  if (!resolved.launchAllowed || !realPath || !resolved.codexVersion) {
    throw new Error("保存的真实 Codex 未通过可执行文件验证；请运行 doctor")
  }
  if (!samePlatformPath(realPath, savedPath, dependencies.platform)) {
    throw new Error(`保存的真实 Codex 身份漂移到 ${realPath}；请运行 doctor 后重新安装`)
  }
  const forbidden = forbiddenGuardPaths(config, dependencies)
  if (forbidden.some((candidate) => samePlatformPath(
    realPath,
    candidate,
    dependencies.platform,
  ))) {
    throw new Error("保存的真实 Codex 指向 Guard 或 shim，拒绝递归；请运行 doctor")
  }
}

function forbiddenGuardPaths(
  config: GlobalGuardConfig,
  dependencies: CliDependencies,
): string[] {
  const forbidden = [dependencies.shim.cliEntryPath]
  if (!config.shellIntegration.shimDirectory) return forbidden
  const platformPath = pathFor(dependencies.platform)
  forbidden.push(
    platformPath.join(config.shellIntegration.shimDirectory, "codex"),
    platformPath.join(config.shellIntegration.shimDirectory, "codex-raw"),
    platformPath.join(config.shellIntegration.shimDirectory, "codex.cmd"),
    platformPath.join(config.shellIntegration.shimDirectory, "codex-raw.cmd"),
  )
  return forbidden
}

function pathFor(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix
}

function samePlatformPath(
  first: string,
  second: string,
  platform: NodeJS.Platform,
): boolean {
  const platformPath = pathFor(platform)
  const normalize = (value: string) => {
    const resolved = platformPath.resolve(value)
    return platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normalize(first) === normalize(second)
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

function formatShellResult(result: ShellOperationResult): string {
  return [
    `status=${result.status}`,
    result.shell ? `shell=${result.shell}` : null,
    result.profilePath ? `profilePath=${result.profilePath}` : null,
    result.shimDirectory ? `shimDirectory=${result.shimDirectory}` : null,
    result.healthy === undefined ? null : `healthy=${String(result.healthy)}`,
    result.observedCodexVersion
      ? `observedCodexVersion=${result.observedCodexVersion}`
      : null,
    ...(result.issues ?? []).map((issue) => `issue=${issue}`),
  ].filter((line): line is string => line !== null).join("\n")
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

export function assertInteractiveCapabilities(
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
  codex-quota-guard shell install [--codex-path <绝对路径>]
  codex-quota-guard shell status [--json]
  codex-quota-guard shell uninstall
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
  旁路：codex-raw         明确执行保存的真实 Codex，不启动额度保护
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
