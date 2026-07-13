import { readFile } from "node:fs/promises"
import path from "node:path"

export interface GuardConfig {
  codexPath?: string
}

export class ConfigStore {
  constructor(private readonly rootDirectory: string) {}

  async load(): Promise<GuardConfig | null> {
    const file = path.join(this.rootDirectory, ".codex-guard", "config.json")
    let raw: string
    try {
      raw = await readFile(file, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null
      throw error
    }

    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Codex Quota Guard 配置必须是 JSON 对象")
    }
    const codexPath = (value as { codexPath?: unknown }).codexPath
    if (codexPath !== undefined
      && (typeof codexPath !== "string" || codexPath.trim() === "")) {
      throw new Error("codexPath 必须是非空字符串")
    }
    return codexPath === undefined ? {} : { codexPath }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
