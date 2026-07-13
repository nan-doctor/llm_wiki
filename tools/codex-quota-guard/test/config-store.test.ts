import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ConfigStore } from "../src/persistence/config-store.js"

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-guard-config-"))
  roots.push(root)
  return root
}

async function writeConfig(root: string, value: unknown): Promise<void> {
  const directory = path.join(root, ".codex-guard")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "config.json"), JSON.stringify(value), "utf8")
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })))
})

describe("ConfigStore", () => {
  it("配置文件不存在时返回 null", async () => {
    const root = await temporaryRoot()

    expect(await new ConfigStore(root).load()).toBeNull()
  })

  it("读取项目本地 codexPath 且保留相对路径", async () => {
    const root = await temporaryRoot()
    await writeConfig(root, { codexPath: "./bin/codex" })

    expect(await new ConfigStore(root).load()).toEqual({ codexPath: "./bin/codex" })
  })

  it("拒绝非对象和无效 codexPath", async () => {
    const root = await temporaryRoot()
    await writeConfig(root, { codexPath: 7 })

    await expect(new ConfigStore(root).load()).rejects.toThrow("codexPath 必须是非空字符串")

    await writeConfig(root, [])
    await expect(new ConfigStore(root).load()).rejects.toThrow(
      "Codex Quota Guard 配置必须是 JSON 对象",
    )
  })
})
