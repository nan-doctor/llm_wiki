import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildCapabilityEvidence,
  buildCapabilityMatrix,
  fingerprintProtocol,
  inspectGeneratedProtocol,
} from "../src/runtime/capabilities.js"

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-capabilities-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })))
})

async function writeProtocol(root: string): Promise<void> {
  await mkdir(path.join(root, "v2"), { recursive: true })
  await writeFile(path.join(root, "ClientRequest.json"), JSON.stringify({
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
  await writeFile(path.join(root, "ServerNotification.json"), JSON.stringify({
    methods: ["account/rateLimits/updated"],
  }))
  await writeFile(path.join(root, "ServerRequest.json"), JSON.stringify({
    title: "ServerRequest",
    oneOf: [{ title: "item/commandExecution/requestApproval" }],
  }))
  await writeFile(path.join(root, "v2", "ThreadGoalSetParams.json"), JSON.stringify({
    definitions: {
      ThreadGoalStatus: { enum: ["active", "paused", "budgetLimited", "complete"] },
    },
  }))
}

describe("协议能力", () => {
  it("识别额度、turn、thread/read、Goal、terminal 和双向请求", async () => {
    const root = await temporaryRoot()
    await writeProtocol(root)

    expect(await inspectGeneratedProtocol(root)).toEqual({
      rateLimitsRead: true,
      rateLimitsUpdated: true,
      turnStart: true,
      turnInterrupt: true,
      threadRead: true,
      goalGet: true,
      goalSet: true,
      goalPaused: true,
      goalResume: true,
      backgroundTerminalsClean: true,
      serverRequestHandling: true,
    })
  })

  it("ServerRequest 文件没有请求定义时不误报双向处理能力", async () => {
    const root = await temporaryRoot()
    await writeProtocol(root)
    await writeFile(path.join(root, "ServerRequest.json"), JSON.stringify({
      title: "ServerRequest",
      oneOf: [],
    }))

    expect((await inspectGeneratedProtocol(root)).serverRequestHandling).toBe(false)
  })

  it("相同 schema 内容得到稳定指纹，内容变化会改变指纹", async () => {
    const first = await temporaryRoot()
    const second = await temporaryRoot()
    await mkdir(path.join(first, "z"))
    await mkdir(path.join(second, "z"))
    await writeFile(path.join(first, "z", "two.json"), "{\"two\":2}\n")
    await writeFile(path.join(first, "one.json"), "{\"one\":1}\n")
    await writeFile(path.join(second, "one.json"), "{\"one\":1}\n")
    await writeFile(path.join(second, "z", "two.json"), "{\"two\":2}\n")

    const firstFingerprint = await fingerprintProtocol(first)
    expect(firstFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(await fingerprintProtocol(second)).toBe(firstFingerprint)

    await writeFile(path.join(second, "z", "two.json"), "{\"two\":3}\n")
    expect(await fingerprintProtocol(second)).not.toBe(firstFingerprint)
  })

  it("存在聚合 v2 schema 时只以其内容生成指纹", async () => {
    const first = await temporaryRoot()
    const second = await temporaryRoot()
    const aggregate = "{\"protocol\":2}\n"
    await writeFile(path.join(first, "codex_app_server_protocol.v2.schemas.json"), aggregate)
    await writeFile(path.join(second, "codex_app_server_protocol.v2.schemas.json"), aggregate)
    await writeFile(path.join(first, "unrelated.json"), "{\"value\":1}")
    await writeFile(path.join(second, "unrelated.json"), "{\"value\":2}")

    expect(await fingerprintProtocol(second)).toBe(await fingerprintProtocol(first))
  })
})

describe("能力证据分级", () => {
  it("区分 unavailable、schemaDetected、runtimeVerified、degraded 和 failed", () => {
    expect(buildCapabilityEvidence(false, undefined)).toEqual({
      schemaDetected: false,
      runtimeVerified: null,
      status: "unavailable",
      detail: null,
    })
    expect(buildCapabilityEvidence(true, undefined).status).toBe("schemaDetected")
    expect(buildCapabilityEvidence(true, true).status).toBe("runtimeVerified")
    expect(buildCapabilityEvidence(true, false, { optional: true }).status).toBe("degraded")
    expect(buildCapabilityEvidence(true, false, { optional: false }).status).toBe("failed")
  })

  it("能力矩阵保留旧字段并增加新能力", () => {
    const matrix = buildCapabilityMatrix({
      rateLimitsRead: true,
      rateLimitsUpdated: true,
      turnStart: true,
      turnInterrupt: true,
      threadRead: true,
      goalGet: true,
      goalSet: true,
      goalPaused: true,
      goalResume: true,
      backgroundTerminalsClean: true,
      serverRequestHandling: true,
    }, { rateLimitsRead: true, goalPaused: false })

    expect(matrix.rateLimitsRead).toMatchObject({
      schemaDetected: true,
      runtimeVerified: true,
      status: "runtimeVerified",
    })
    expect(matrix.turnInterrupt.status).toBe("schemaDetected")
    expect(matrix.goalPaused.status).toBe("degraded")
    expect(matrix.threadRead.status).toBe("schemaDetected")
    expect(matrix.goalResume.status).toBe("schemaDetected")
    expect(matrix.serverRequestHandling.status).toBe("schemaDetected")
  })
})
