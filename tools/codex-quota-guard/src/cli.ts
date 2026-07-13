#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import readline from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { AppServerManager } from "./app-server/manager.js"
import { ProcessAppServerConnection } from "./app-server/process-connection.js"
import { executeCli, type CliDependencies } from "./cli-runtime.js"
import { runDoctor } from "./doctor.js"
import { GuardController } from "./guard/controller.js"
import { runInteractivePreflight } from "./interactive/preflight.js"
import { InteractiveSession } from "./interactive/session.js"
import { TuiProcess } from "./interactive/tui-process.js"
import { ProcessLock } from "./persistence/process-lock.js"
import { ConfigStore } from "./persistence/config-store.js"
import { GlobalConfigStore } from "./persistence/global-config-store.js"
import { StateStore } from "./persistence/state-store.js"
import { detectCurrentShell } from "./shell/current-shell.js"
import { ShellInstaller, type ShellVerificationDetails } from "./shell/installer.js"
import { InteractiveAppServerClient } from "./proxy/interactive-app-server-client.js"
import { LocalTuiEndpoint } from "./proxy/local-tui-endpoint.js"
import { RawAppServerProcess } from "./proxy/raw-app-server-process.js"
import { TransparentJsonRpcProxy } from "./proxy/transparent-proxy.js"
import { LocalThresholdReporter } from "./report/local-reporter.js"
import { createRuntimeContext } from "./runtime/runtime-context.js"

const rootDirectory = process.cwd()
const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir()
const globalConfigStore = new GlobalConfigStore({
  platform: process.platform,
  home,
  localAppData: process.env.LOCALAPPDATA,
})

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
  createShellInstaller: () => {
    let powerShellExecutable = "powershell.exe"
    return new ShellInstaller({
      rootDirectory,
      globalStore: globalConfigStore,
      nodeExecutable: process.execPath,
      cliEntry: fileURLToPath(import.meta.url),
      platform: process.platform,
      home,
      detectShell: async () => {
        const parentProcessName = await directParentProcessName(process.platform)
        powerShellExecutable = path.win32.basename(parentProcessName).toLowerCase() === "pwsh.exe"
          ? "pwsh.exe"
          : "powershell.exe"
        const powershellProfilePath = process.platform === "win32"
          ? await readPowerShellProfilePath(powerShellExecutable)
          : undefined
        return await detectCurrentShell({
          platform: process.platform,
          shellPath: process.env.SHELL ?? "",
          parentProcessName,
          home,
          powershellProfilePath,
        })
      },
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      confirm: async (prompt) => await askForConfirmation(prompt),
      writeOutput: (line) => process.stdout.write(`${line}\n`),
      verifyInstallation: async (details) => await verifyShellResolution(
        details,
        powerShellExecutable,
      ),
      currentPath: process.env.PATH,
    })
  },
  platform: process.platform,
  globalConfigStore,
  loadProjectConfig: async () => await new ConfigStore(rootDirectory).load(),
  acquireLock: async () => await ProcessLock.acquire(rootDirectory),
  liveCanaryConsent: process.env.CODEX_QUOTA_GUARD_LIVE_CANARY === "I_ACCEPT_MODEL_USAGE",
  runDoctor: async (context, liveCanary) => await runDoctor(context, { liveCanary }),
  writeOutput: (value) => process.stdout.write(`${value}\n`),
}

async function askForConfirmation(prompt: string): Promise<string> {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await terminal.question(prompt)
  } finally {
    terminal.close()
  }
}

async function directParentProcessName(platform: NodeJS.Platform): Promise<string> {
  if (platform === "win32") {
    const command = `(Get-Process -Id ${process.ppid}).Path`
    const result = await runExecutable("powershell.exe", ["-NoProfile", "-Command", command])
    return path.win32.basename(result.stdout.trim())
  }
  const result = await runExecutable("ps", ["-p", String(process.ppid), "-o", "comm="])
  return path.basename(result.stdout.trim())
}

async function readPowerShellProfilePath(executable: string): Promise<string> {
  const result = await runExecutable(executable, [
    "-NoProfile",
    "-Command",
    "$PROFILE.CurrentUserCurrentHost",
  ])
  return result.stdout.trim()
}

async function verifyShellResolution(
  details: ShellVerificationDetails,
  powerShellExecutable: string,
): Promise<void> {
  const expected = path.join(
    details.shimDirectory,
    process.platform === "win32" ? "codex.cmd" : "codex",
  )
  let result: { stdout: string; stderr: string }
  if (details.shell === "powershell") {
    const command = `. ${quotePowerShell(details.profilePath)}; (Get-Command codex).Source`
    result = await runExecutable(powerShellExecutable, ["-NoProfile", "-Command", command])
  } else {
    const source = `. ${quotePosix(details.profilePath)}; command -v codex`
    result = await runExecutable(details.shell, [
      details.shell === "zsh" ? "-f" : "--noprofile",
      "-c",
      source,
    ], { HOME: home })
  }
  const resolved = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (!resolved) throw new Error(`PATH 验证失败：没有解析到 codex；${result.stderr.trim()}`)
  const [actualRealPath, expectedRealPath] = await Promise.all([
    realpath(resolved),
    realpath(expected),
  ])
  if (actualRealPath !== expectedRealPath) {
    throw new Error(`PATH 验证失败：codex 解析到 ${resolved}，预期 ${expected}`)
  }
}

function runExecutable(
  executable: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      env: { ...process.env, ...environment },
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(
          `命令验证失败：${executable}；${stderr.trim() || error.message}`,
          { cause: error },
        ))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

executeCli(process.argv.slice(2), dependencies)
  .then((code) => { process.exitCode = code })
  .catch((error: unknown) => {
    process.stderr.write(`Codex Quota Guard 错误：${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
