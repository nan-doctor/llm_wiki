import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  createRuntimeContext,
  type RuntimeContextDependencies,
} from "../src/runtime/runtime-context.js"
import type { ResolvedCodexExecutable } from "../src/runtime/types.js"

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-context-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })))
})

function selectedExecutable(): ResolvedCodexExecutable {
  return {
    codexExecutable: "/chosen/codex",
    codexExecutableRealPath: "/real/chosen/codex",
    codexVersion: "codex-cli 0.144.0-alpha.4",
    executableSelectionSource: "cli",
    launchAllowed: true,
    discoveredCandidates: [],
  }
}

async function writeSchema(directory: string): Promise<void> {
  await mkdir(path.join(directory, "v2"), { recursive: true })
  await writeFile(path.join(directory, "ClientRequest.json"), JSON.stringify({
    methods: [
      "account/rateLimits/read",
      "turn/start",
      "turn/interrupt",
      "thread/read",
      "thread/goal/get",
      "thread/goal/set",
      "thread/backgroundTerminals/clean",
    ],
  }))
  await writeFile(path.join(directory, "ServerNotification.json"), JSON.stringify({
    methods: ["account/rateLimits/updated"],
  }))
  await writeFile(path.join(directory, "ServerRequest.json"), JSON.stringify({ oneOf: [{}] }))
  await writeFile(path.join(directory, "v2", "ThreadGoalSetParams.json"), JSON.stringify({
    definitions: { ThreadGoalStatus: { enum: ["active", "paused"] } },
  }))
}

describe("createRuntimeContext", () => {
  it("组合 resolver、项目配置、schema 能力和稳定指纹", async () => {
    const schemaDirectory = await temporaryRoot()
    let resolvedInput: unknown = null
    let generatedWith: string | null = null
    const helpCalls: Array<{ executable: string; args: string[] }> = []
    let removed = false
    const dependencies: RuntimeContextDependencies = {
      loadConfig: async () => ({ codexPath: "./configured/codex" }),
      resolveExecutable: async (input) => {
        resolvedInput = input
        return selectedExecutable()
      },
      createTemporaryDirectory: async () => schemaDirectory,
      generateSchema: async (executable, output) => {
        generatedWith = executable
        expect(output).toBe(schemaDirectory)
        await writeSchema(output)
      },
      readHelp: async (executable, args) => {
        helpCalls.push({ executable, args })
        return args[0] === "--help"
          ? "--remote <ADDR> --remote-auth-token-env <ENV_VAR> unix://PATH ws://IP:PORT"
          : "--listen <URI> stdio:// unix://PATH ws://IP:PORT"
      },
      removeTemporaryDirectory: async () => { removed = true },
    }

    const context = await createRuntimeContext({
      rootDirectory: "/repo",
      cliPath: "/chosen/codex",
      environmentPath: "/environment/codex",
    }, dependencies)

    expect(resolvedInput).toEqual({
      rootDirectory: "/repo",
      cliPath: "/chosen/codex",
      environmentPath: "/environment/codex",
      configPath: "./configured/codex",
    })
    expect(generatedWith).toBe("/real/chosen/codex")
    expect(removed).toBe(true)
    expect(helpCalls).toEqual([
      { executable: "/real/chosen/codex", args: ["--help"] },
      { executable: "/real/chosen/codex", args: ["app-server", "--help"] },
    ])
    expect(context).toMatchObject({
      executable: selectedExecutable(),
      protocolFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      schemaCapabilities: {
        rateLimitsRead: true,
        turnInterrupt: true,
        threadRead: true,
      },
      capabilityMatrix: {
        rateLimitsRead: { status: "schemaDetected", runtimeVerified: null },
      },
      remoteCapabilities: {
        remoteTui: true,
        remoteAuthTokenEnv: true,
        remoteUnixSocket: true,
        remoteLoopbackWebSocket: true,
        appServerStdio: true,
      },
    })
  })

  it("候选诊断上下文不执行 schema 生成", async () => {
    let generated = false
    let helpRead = false
    const candidate: ResolvedCodexExecutable = {
      codexExecutable: "/Applications/ChatGPT.app/Contents/Resources/codex",
      codexExecutableRealPath: null,
      codexVersion: null,
      executableSelectionSource: "discoveredCandidate",
      launchAllowed: false,
      discoveredCandidates: ["/Applications/ChatGPT.app/Contents/Resources/codex"],
    }
    const dependencies: RuntimeContextDependencies = {
      loadConfig: async () => null,
      resolveExecutable: async () => candidate,
      createTemporaryDirectory: async () => await temporaryRoot(),
      generateSchema: async () => { generated = true },
      readHelp: async () => { helpRead = true; return "" },
      removeTemporaryDirectory: async () => undefined,
    }

    const context = await createRuntimeContext({ rootDirectory: "/repo" }, dependencies)

    expect(generated).toBe(false)
    expect(helpRead).toBe(false)
    expect(context).toMatchObject({
      executable: candidate,
      protocolFingerprint: null,
      schemaCapabilities: {
        rateLimitsRead: false,
        turnInterrupt: false,
      },
      remoteCapabilities: {
        remoteTui: false,
        remoteAuthTokenEnv: false,
        remoteUnixSocket: false,
        remoteLoopbackWebSocket: false,
        appServerStdio: false,
      },
    })
  })

  it("schema 生成失败时仍清理临时目录", async () => {
    const schemaDirectory = await temporaryRoot()
    let removed = false
    const dependencies: RuntimeContextDependencies = {
      loadConfig: async () => null,
      resolveExecutable: async () => selectedExecutable(),
      createTemporaryDirectory: async () => schemaDirectory,
      generateSchema: async () => { throw new Error("schema failed") },
      readHelp: async () => "",
      removeTemporaryDirectory: async () => { removed = true },
    }

    await expect(createRuntimeContext({ rootDirectory: "/repo" }, dependencies))
      .rejects.toThrow("schema failed")
    expect(removed).toBe(true)
  })

  it("每次创建上下文都重新读取同一真实二进制的 schema 与 help", async () => {
    let schemaCount = 0
    let helpCount = 0
    const dependencies: RuntimeContextDependencies = {
      loadConfig: async () => null,
      resolveExecutable: async () => selectedExecutable(),
      createTemporaryDirectory: async () => await temporaryRoot(),
      generateSchema: async (_executable, output) => {
        schemaCount += 1
        await writeSchema(output)
      },
      readHelp: async () => {
        helpCount += 1
        return "--remote --remote-auth-token-env unix:// ws:// stdio://"
      },
      removeTemporaryDirectory: async () => undefined,
    }

    await createRuntimeContext({ rootDirectory: "/repo" }, dependencies)
    await createRuntimeContext({ rootDirectory: "/repo" }, dependencies)

    expect(schemaCount).toBe(2)
    expect(helpCount).toBe(4)
  })
})
