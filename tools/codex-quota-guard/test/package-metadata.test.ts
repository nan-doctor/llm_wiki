import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("npm 包元数据", () => {
  it("0.3.0 只发布 Guard 命令，默认 codex shim 必须由用户确认生成", async () => {
    const packageJson = JSON.parse(await readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    )) as {
      version: string
      dependencies?: Record<string, string>
      bin?: Record<string, string>
    }

    expect(packageJson.version).toBe("0.3.0")
    expect(packageJson.dependencies?.ws).toBeTruthy()
    expect(packageJson.bin).toEqual({
      "codex-quota-guard": "dist/src/cli.js",
    })
    expect(packageJson.bin).not.toHaveProperty("codex")
    expect(packageJson.bin).not.toHaveProperty("codex-raw")
  })
})
