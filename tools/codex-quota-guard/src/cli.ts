#!/usr/bin/env node
import { AppServerManager } from "./app-server/manager.js"
import { ProcessAppServerConnection } from "./app-server/process-connection.js"
import { executeCli, type CliDependencies } from "./cli-runtime.js"
import { runDoctor } from "./doctor.js"
import { GuardController } from "./guard/controller.js"
import { ProcessLock } from "./persistence/process-lock.js"
import { StateStore } from "./persistence/state-store.js"
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
    )
  },
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
