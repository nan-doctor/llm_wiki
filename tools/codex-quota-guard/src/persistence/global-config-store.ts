import { randomUUID } from "node:crypto"
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"

export type SupportedShell = "zsh" | "bash" | "powershell"

export interface GlobalGuardConfig {
  defaultInteractiveProtection: boolean
  defaultRequireProtection: boolean
  realCodexExecutable: string | null
  realCodexVersion: string | null
  shellIntegration: {
    enabled: boolean
    shimDirectory: string | null
    installedAt: string | null
    shells: Array<{ shell: SupportedShell; profilePath: string }>
  }
}

export interface GlobalConfigStoreOptions {
  platform: NodeJS.Platform
  home: string
  localAppData?: string
}

export function defaultGlobalGuardConfig(): GlobalGuardConfig {
  return {
    defaultInteractiveProtection: true,
    defaultRequireProtection: false,
    realCodexExecutable: null,
    realCodexVersion: null,
    shellIntegration: {
      enabled: false,
      shimDirectory: null,
      installedAt: null,
      shells: [],
    },
  }
}

export class GlobalConfigStore {
  readonly configDirectory: string
  readonly configPath: string

  constructor(private readonly options: GlobalConfigStoreOptions) {
    const base = options.platform === "win32"
      ? options.localAppData
      : path.join(options.home, ".local", "share")
    if (!base) throw new Error("Windows 全局配置需要 LOCALAPPDATA")
    this.configDirectory = path.join(base, "codex-quota-guard")
    this.configPath = path.join(this.configDirectory, "config.json")
  }

  async load(): Promise<GlobalGuardConfig> {
    let raw: string
    try {
      raw = await readFile(this.configPath, "utf8")
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return defaultGlobalGuardConfig()
      throw error
    }
    return normalizeConfig(JSON.parse(raw) as unknown)
  }

  async save(input: GlobalGuardConfig): Promise<void> {
    const config = normalizeConfig(input)
    await mkdir(this.configDirectory, { recursive: true, mode: 0o700 })
    if (this.options.platform !== "win32") await chmod(this.configDirectory, 0o700)
    const temporaryPath = `${this.configPath}.tmp-${process.pid}-${randomUUID()}`
    const handle = await open(temporaryPath, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporaryPath, this.configPath)
      if (this.options.platform !== "win32") await chmod(this.configPath, 0o600)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }

  async update(
    mutator: (config: GlobalGuardConfig) => void | GlobalGuardConfig,
  ): Promise<GlobalGuardConfig> {
    const current = await this.load()
    const draft = structuredClone(current)
    const returned = mutator(draft)
    const next = normalizeConfig(returned ?? draft)
    await this.save(next)
    return next
  }
}

function normalizeConfig(value: unknown): GlobalGuardConfig {
  const defaults = defaultGlobalGuardConfig()
  const input = isRecord(value) ? value : {}
  const shellInput = isRecord(input.shellIntegration) ? input.shellIntegration : {}
  return {
    defaultInteractiveProtection: typeof input.defaultInteractiveProtection === "boolean"
      ? input.defaultInteractiveProtection
      : defaults.defaultInteractiveProtection,
    defaultRequireProtection: typeof input.defaultRequireProtection === "boolean"
      ? input.defaultRequireProtection
      : defaults.defaultRequireProtection,
    realCodexExecutable: nullableString(input.realCodexExecutable),
    realCodexVersion: nullableString(input.realCodexVersion),
    shellIntegration: {
      enabled: typeof shellInput.enabled === "boolean"
        ? shellInput.enabled
        : defaults.shellIntegration.enabled,
      shimDirectory: nullableString(shellInput.shimDirectory),
      installedAt: nullableString(shellInput.installedAt),
      shells: Array.isArray(shellInput.shells)
        ? shellInput.shells.flatMap((entry) => normalizeShell(entry))
        : [],
    },
  }
}

function normalizeShell(value: unknown): Array<{
  shell: SupportedShell
  profilePath: string
}> {
  if (!isRecord(value)
    || (value.shell !== "zsh" && value.shell !== "bash" && value.shell !== "powershell")
    || typeof value.profilePath !== "string") return []
  return [{ shell: value.shell, profilePath: value.profilePath }]
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
