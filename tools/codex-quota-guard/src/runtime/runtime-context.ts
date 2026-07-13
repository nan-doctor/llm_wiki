import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigStore, type GuardConfig } from "../persistence/config-store.js"
import {
  buildCapabilityMatrix,
  emptyCapabilities,
  fingerprintProtocol,
  inspectGeneratedProtocol,
} from "./capabilities.js"
import {
  resolveCodexExecutable,
  type ResolveCodexInput,
} from "./executable-resolver.js"
import type { ResolvedCodexExecutable, RuntimeContext } from "./types.js"
import {
  emptyRemoteCapabilities,
  inspectRemoteCapabilities,
} from "./remote-capabilities.js"

export interface CreateRuntimeContextInput {
  rootDirectory: string
  cliPath?: string
  environmentPath?: string
}

export interface RuntimeContextDependencies {
  loadConfig(rootDirectory: string): Promise<GuardConfig | null>
  resolveExecutable(input: ResolveCodexInput): Promise<ResolvedCodexExecutable>
  createTemporaryDirectory(): Promise<string>
  generateSchema(executable: string, outputDirectory: string): Promise<void>
  readHelp(executable: string, args: string[]): Promise<string>
  removeTemporaryDirectory(directory: string): Promise<void>
}

export async function createRuntimeContext(
  input: CreateRuntimeContextInput,
  dependencies: RuntimeContextDependencies = defaultRuntimeContextDependencies(),
): Promise<RuntimeContext> {
  const config = await dependencies.loadConfig(input.rootDirectory)
  const executable = await dependencies.resolveExecutable({
    rootDirectory: input.rootDirectory,
    cliPath: input.cliPath,
    environmentPath: input.environmentPath ?? process.env.CODEX_QUOTA_GUARD_CODEX_PATH,
    configPath: config?.codexPath,
  })

  if (!executable.launchAllowed) {
    const schemaCapabilities = emptyCapabilities()
    return {
      executable,
      protocolFingerprint: null,
      schemaCapabilities,
      capabilityMatrix: buildCapabilityMatrix(schemaCapabilities),
      remoteCapabilities: emptyRemoteCapabilities(),
    }
  }
  if (!executable.codexExecutableRealPath) {
    throw new Error("已选择的 Codex 缺少真实绝对路径")
  }

  const temporaryDirectory = await dependencies.createTemporaryDirectory()
  try {
    await dependencies.generateSchema(
      executable.codexExecutableRealPath,
      temporaryDirectory,
    )
    const [tuiHelp, appServerHelp] = await Promise.all([
      dependencies.readHelp(executable.codexExecutableRealPath, ["--help"]),
      dependencies.readHelp(executable.codexExecutableRealPath, ["app-server", "--help"]),
    ])
    const schemaCapabilities = await inspectGeneratedProtocol(temporaryDirectory)
    return {
      executable,
      protocolFingerprint: await fingerprintProtocol(temporaryDirectory),
      schemaCapabilities,
      capabilityMatrix: buildCapabilityMatrix(schemaCapabilities),
      remoteCapabilities: inspectRemoteCapabilities({ tuiHelp, appServerHelp }),
    }
  } finally {
    await dependencies.removeTemporaryDirectory(temporaryDirectory)
  }
}

function defaultRuntimeContextDependencies(): RuntimeContextDependencies {
  return {
    loadConfig: async (rootDirectory) => await new ConfigStore(rootDirectory).load(),
    resolveExecutable: async (input) => await resolveCodexExecutable(input),
    createTemporaryDirectory: async () => await mkdtemp(path.join(
      os.tmpdir(),
      "codex-quota-guard-schema-",
    )),
    generateSchema: generateSchema,
    readHelp: readHelp,
    removeTemporaryDirectory: async (directory) => await rm(directory, {
      recursive: true,
      force: true,
    }),
  }
}

function readHelp(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: "utf8",
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve(`${stdout}\n${stderr}`)
    })
  })
}

async function generateSchema(executable: string, outputDirectory: string): Promise<void> {
  await runCommand(executable, [
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    outputDirectory,
  ])
}

function runCommand(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: "utf8",
      windowsHide: true,
    }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

export type { RuntimeContext } from "./types.js"
