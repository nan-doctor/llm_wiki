#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto"
import { AppServerManager } from "./app-server/manager.js"
import { ProcessAppServerConnection } from "./app-server/process-connection.js"
import { executeCli, type CliDependencies } from "./cli-runtime.js"
import { runDoctor } from "./doctor.js"
import { GuardController } from "./guard/controller.js"
import { runInteractivePreflight } from "./interactive/preflight.js"
import { InteractiveSession } from "./interactive/session.js"
import { TuiProcess } from "./interactive/tui-process.js"
import { ProcessLock } from "./persistence/process-lock.js"
import { StateStore } from "./persistence/state-store.js"
import { InteractiveAppServerClient } from "./proxy/interactive-app-server-client.js"
import { LocalTuiEndpoint } from "./proxy/local-tui-endpoint.js"
import { RawAppServerProcess } from "./proxy/raw-app-server-process.js"
import { TransparentJsonRpcProxy } from "./proxy/transparent-proxy.js"
import { LocalThresholdReporter } from "./report/local-reporter.js"
import { createRuntimeContext } from "./runtime/runtime-context.js"

const rootDirectory = process.cwd()

const dependencies: CliDependencies = {
  rootDirectory,
  resolveRuntimeContext: async (codexPath) => await createRuntimeContext({
    rootDirectory,
    cliPath: codexPath,
  }),
  createController: (context) => {
    const codexPath = context.executable.codexExecutableRealPath
    if (!codexPath) throw new Error("已解析的 Codex 没有可启动的真实路径")
    const manager = new AppServerManager(
      () => new ProcessAppServerConnection({ codexPath, enableGoals: true }),
    )
    return new GuardController(
      manager,
      new StateStore(rootDirectory),
      new LocalThresholdReporter(rootDirectory),
      { runtimeContext: context },
    )
  },
  createInteractiveSession: (context) => {
    const codexPath = context.executable.codexExecutableRealPath
    if (!codexPath) throw new Error("已解析的 Codex 没有可启动的真实路径")
    const stateStore = new StateStore(rootDirectory)
    const reporter = new LocalThresholdReporter(rootDirectory)
    const sessionNonce = randomUUID()
    const sessionGeneration = randomUUID()
    const raw = new RawAppServerProcess({
      codexPath,
      enableGoals: true,
      environment: process.env,
    })
    return new InteractiveSession({
      runPreflight: async ({ requireProtection }) => {
        const manager = new AppServerManager(
          () => new ProcessAppServerConnection({ codexPath, enableGoals: true }),
        )
        const controller = new GuardController(manager, stateStore, reporter, {
          runtimeContext: context,
        })
        const result = await runInteractivePreflight(controller, {
          requireProtection,
          runtimeContext: context,
        })
        process.stdout.write(`${result.text}\n`)
      },
      raw,
      createToken: () => randomBytes(32).toString("base64url"),
      createEndpoint: async (token) => await LocalTuiEndpoint.create({
        platform: process.platform,
        token,
      }),
      createProxy: (endpoint) => new TransparentJsonRpcProxy(endpoint, raw, {
        sessionNonce,
      }),
      createController: (sessionProxy) => {
        const proxy = sessionProxy as TransparentJsonRpcProxy
        const client = new InteractiveAppServerClient(proxy, {
          sessionGeneration,
        })
        const controller = new GuardController(client, stateStore, reporter, {
          runtimeContext: context,
          interactiveSession: {
            generation: sessionGeneration,
            clearUnboundActiveTurnOnStart: true,
          },
        })
        return {
          start: async () => await controller.start(),
          waitUntilListening: async () => await client.waitUntilSubscribed(),
          shutdownInteractiveSession: async () => {
            await controller.shutdownInteractiveSession()
          },
          stop: async () => await controller.stop(),
        }
      },
      createTui: (options) => new TuiProcess({
        executable: codexPath,
        remoteAddress: options.remoteAddress,
        tokenEnvironmentName: options.tokenEnvironmentName,
        token: options.token,
        tuiArgs: options.tuiArgs,
        environment: process.env,
      }),
      tokenEnvironmentName: "CODEX_QUOTA_GUARD_REMOTE_TOKEN",
      signalSource: process,
    })
  },
  platform: process.platform,
  acquireLock: async () => await ProcessLock.acquire(rootDirectory),
  liveCanaryConsent: process.env.CODEX_QUOTA_GUARD_LIVE_CANARY === "I_ACCEPT_MODEL_USAGE",
  runDoctor: async (context, liveCanary) => await runDoctor(context, { liveCanary }),
  writeOutput: (value) => process.stdout.write(`${value}\n`),
}

executeCli(process.argv.slice(2), dependencies)
  .then((code) => { process.exitCode = code })
  .catch((error: unknown) => {
    process.stderr.write(`Codex Quota Guard 错误：${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
