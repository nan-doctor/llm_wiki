import { readFile, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  GlobalConfigStore,
  defaultGlobalGuardConfig,
  type GlobalGuardConfig,
} from "../src/persistence/global-config-store.js"

const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await import("node:fs/promises").then(async ({ mkdtemp }) => (
    await mkdtemp(path.join(os.tmpdir(), "codex-guard-global-config-"))
  ))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, {
    recursive: true,
    force: true,
  })))
})

describe("GlobalConfigStore", () => {
  it.each([
    ["darwin", "home", ".local/share/codex-quota-guard/config.json"],
    ["linux", "home", ".local/share/codex-quota-guard/config.json"],
    ["win32", "local", "codex-quota-guard/config.json"],
  ] as const)("%s 使用独立平台配置路径和安全默认值", async (platform, base, relative) => {
    const root = await temporaryRoot()
    const store = new GlobalConfigStore({
      platform,
      home: path.join(root, "home"),
      localAppData: path.join(root, "local"),
    })

    expect(store.configPath).toBe(path.join(root, base, relative))
    expect(await store.load()).toEqual(defaultGlobalGuardConfig())
  })

  it("Unix 原子保存为 0700/0600 且更新不残留临时文件", async () => {
    const root = await temporaryRoot()
    const store = new GlobalConfigStore({
      platform: "darwin",
      home: root,
    })
    const first = defaultGlobalGuardConfig()
    first.defaultRequireProtection = true
    await store.save(first)
    await store.update((config) => {
      config.realCodexExecutable = "/path with spaces/codex"
      config.realCodexVersion = "codex-cli 1.0.0"
    })

    expect((await stat(store.configDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(store.configPath)).mode & 0o777).toBe(0o600)
    expect((await readdir(store.configDirectory)).filter((name) => name.includes(".tmp-")))
      .toEqual([])
    expect(await store.load()).toMatchObject({
      defaultRequireProtection: true,
      realCodexExecutable: "/path with spaces/codex",
      realCodexVersion: "codex-cli 1.0.0",
    })
  })

  it("保存前只重建白名单字段且不保留认证材料", async () => {
    const root = await temporaryRoot()
    const store = new GlobalConfigStore({ platform: "linux", home: root })
    const malicious = {
      ...defaultGlobalGuardConfig(),
      accessToken: "secret-access",
      unknown: "must-not-persist",
      shellIntegration: {
        ...defaultGlobalGuardConfig().shellIntegration,
        cookie: "secret-cookie",
        shells: [{ shell: "zsh", profilePath: "/home/me/.zshrc", token: "secret-shell" }],
      },
    } as unknown as GlobalGuardConfig

    await store.save(malicious)

    const raw = await readFile(store.configPath, "utf8")
    expect(raw).not.toContain("secret-access")
    expect(raw).not.toContain("secret-cookie")
    expect(raw).not.toContain("secret-shell")
    expect(raw).not.toContain("must-not-persist")
    expect(await store.load()).toEqual({
      ...defaultGlobalGuardConfig(),
      shellIntegration: {
        ...defaultGlobalGuardConfig().shellIntegration,
        shells: [{ shell: "zsh", profilePath: "/home/me/.zshrc" }],
      },
    })
  })
})
