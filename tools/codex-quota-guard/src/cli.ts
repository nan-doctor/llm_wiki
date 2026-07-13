#!/usr/bin/env node
import { AppServerManager } from "./app-server/manager.js"
import { ProcessAppServerConnection } from "./app-server/process-connection.js"
import { executeCli, type CliDependencies } from "./cli-runtime.js"
import { runDoctor } from "./doctor.js"
import { GuardController } from "./guard/controller.js"
import { ProcessLock } from "./persistence/process-lock.js"
import { StateStore } from "./persistence/state-store.js"
import { LocalThresholdReporter } from "./report/local-reporter.js"

const rootDirectory = process.cwd()

const dependencies: CliDependencies = {
  rootDirectory,
  createController: () => {
    const manager = new AppServerManager(
      () => new ProcessAppServerConnection({ enableGoals: true }),
    )
    return new GuardController(
      manager,
      new StateStore(rootDirectory),
      new LocalThresholdReporter(rootDirectory),
    )
  },
  acquireLock: async () => await ProcessLock.acquire(rootDirectory),
  liveCanaryConsent: process.env.CODEX_QUOTA_GUARD_LIVE_CANARY === "I_ACCEPT_MODEL_USAGE",
  runDoctor: async (liveCanary) => await runDoctor("codex", { liveCanary }),
  writeOutput: (value) => process.stdout.write(`${value}\n`),
}

executeCli(process.argv.slice(2), dependencies)
  .then((code) => { process.exitCode = code })
  .catch((error: unknown) => {
    process.stderr.write(`Codex Quota Guard 错误：${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
