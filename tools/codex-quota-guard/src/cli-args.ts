export type ParsedCliArgs =
  | { command: "help" }
  | {
      command: "shell"
      operation: "install"
      codexPath: string | undefined
    }
  | { command: "shell"; operation: "status"; json: boolean }
  | { command: "shell"; operation: "uninstall" }
  | {
      command: "interactive"
      codexPath: string | undefined
      requireProtection: boolean
      tuiArgs: string[]
    }
  | { command: "config"; operation: "show"; json: boolean }
  | {
      command: "config"
      operation: "set-default-require-protection"
      value: boolean
    }
  | { command: "status"; json: boolean; codexPath: string | undefined }
  | {
      command: "doctor"
      json: boolean
      liveCanary: boolean
      codexPath: string | undefined
    }
  | {
      command: "run"
      prompt: string
      threadId: string | undefined
      goal: string | undefined
      tokenBudget: number | undefined
      maxRuntimeMs: number | undefined
      maxTurns: number | undefined
      requireProtection: boolean
      requireGoalControl: boolean
      codexPath: string | undefined
      json: boolean
    }
  | {
      command: "resume"
      prompt: string | undefined
      requireGoalControl: boolean
      codexPath: string | undefined
      json: boolean
    }

export function parseCliArgs(args: string[]): ParsedCliArgs {
  const [command, ...rest] = args
  if (command === "--help" || command === "-h" || command === "help") {
    if (rest.length > 0) throw new Error("help 不接受其他参数")
    return { command: "help" }
  }
  if (command === "status") {
    const parsed = parseOptions(rest, new Set(["json", "codex-path"]))
    if (parsed.positionals.length > 0) throw new Error(`${command} 不接受位置参数`)
    return {
      command,
      json: parsed.flags.has("json"),
      codexPath: parsed.values.get("codex-path"),
    }
  }
  if (command === "shell") {
    const [operation, ...shellArgs] = rest
    if (operation === "install") {
      const parsed = parseOptions(shellArgs, new Set(["codex-path"]))
      if (parsed.positionals.length > 0) throw new Error("shell install 不接受位置参数")
      return {
        command,
        operation,
        codexPath: parsed.values.get("codex-path"),
      }
    }
    if (operation === "status") {
      const parsed = parseOptions(shellArgs, new Set(["json"]))
      if (parsed.positionals.length > 0) throw new Error("shell status 不接受位置参数")
      return { command, operation, json: parsed.flags.has("json") }
    }
    if (operation === "uninstall") {
      if (shellArgs.length > 0) throw new Error("shell uninstall 不接受其他参数")
      return { command, operation }
    }
    throw new Error(`shell 未知操作：${operation ?? "(空)"}`)
  }
  if (command === "config") {
    const [operation, ...configArgs] = rest
    if (operation === "show") {
      const parsed = parseOptions(configArgs, new Set(["json"]))
      if (parsed.positionals.length > 0) throw new Error("config show 不接受位置参数")
      return { command, operation, json: parsed.flags.has("json") }
    }
    if (operation === "set") {
      const [key, value, ...extra] = configArgs
      if (key !== "default-require-protection") {
        throw new Error(`config set 不支持键：${key ?? "(空)"}`)
      }
      if (value !== "true" && value !== "false") {
        throw new Error("default-require-protection 只接受 true 或 false")
      }
      if (extra.length > 0) throw new Error("config set 参数过多")
      return {
        command,
        operation: "set-default-require-protection",
        value: value === "true",
      }
    }
    throw new Error(`config 未知操作：${operation ?? "(空)"}`)
  }
  if (command === "interactive") {
    const separator = rest.indexOf("--")
    const guardArgs = separator === -1 ? rest : rest.slice(0, separator)
    const tuiArgs = separator === -1 ? [] : rest.slice(separator + 1)
    const parsed = parseOptions(guardArgs, new Set([
      "require-protection",
      "codex-path",
    ]))
    if (parsed.positionals.length > 0) {
      throw new Error("interactive 不接受位置任务提示；任务提示请在 TUI 内输入")
    }
    if (tuiArgs.some(isGuardOwnedRemoteArgument)) {
      throw new Error("remote 参数由 Codex Quota Guard 独占，不得传给原生 TUI")
    }
    return {
      command,
      codexPath: parsed.values.get("codex-path"),
      requireProtection: parsed.flags.has("require-protection"),
      tuiArgs,
    }
  }
  if (command === "doctor") {
    const parsed = parseOptions(rest, new Set(["json", "live-canary", "codex-path"]))
    if (parsed.positionals.length > 0) throw new Error(`${command} 不接受位置参数`)
    return {
      command,
      json: parsed.flags.has("json"),
      liveCanary: parsed.flags.has("live-canary"),
      codexPath: parsed.values.get("codex-path"),
    }
  }
  if (command === "run") {
    const parsed = parseOptions(rest, new Set([
      "json",
      "thread",
      "goal",
      "token-budget",
      "max-runtime",
      "max-turns",
      "require-protection",
      "require-goal-control",
      "codex-path",
    ]))
    const prompt = parsed.positionals.join(" ").trim()
    if (!prompt) throw new Error("run 需要提示")
    return {
      command,
      prompt,
      threadId: parsed.values.get("thread"),
      goal: parsed.values.get("goal"),
      tokenBudget: optionalPositiveInteger(parsed.values.get("token-budget"), "token-budget"),
      maxRuntimeMs: optionalDuration(parsed.values.get("max-runtime")),
      maxTurns: optionalPositiveInteger(parsed.values.get("max-turns"), "max-turns"),
      requireProtection: parsed.flags.has("require-protection"),
      requireGoalControl: parsed.flags.has("require-goal-control"),
      codexPath: parsed.values.get("codex-path"),
      json: parsed.flags.has("json"),
    }
  }
  if (command === "resume") {
    const parsed = parseOptions(rest, new Set([
      "json",
      "require-goal-control",
      "codex-path",
    ]))
    const prompt = parsed.positionals.join(" ").trim()
    return {
      command,
      prompt: prompt || undefined,
      requireGoalControl: parsed.flags.has("require-goal-control"),
      codexPath: parsed.values.get("codex-path"),
      json: parsed.flags.has("json"),
    }
  }
  throw new Error(`未知命令：${command ?? "(空)"}`)
}

function isGuardOwnedRemoteArgument(value: string): boolean {
  return value === "--remote"
    || value.startsWith("--remote=")
    || value === "--remote-auth-token-env"
    || value.startsWith("--remote-auth-token-env=")
}

function parseOptions(args: string[], allowed: Set<string>): {
  flags: Set<string>
  values: Map<string, string>
  positionals: string[]
} {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const positionals: string[] = []
  const booleanFlags = new Set([
    "json",
    "require-protection",
    "require-goal-control",
    "live-canary",
  ])
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (!value.startsWith("--")) {
      positionals.push(value)
      continue
    }
    const name = value.slice(2)
    if (!allowed.has(name)) throw new Error(`未知参数：--${name}`)
    if (booleanFlags.has(name)) {
      flags.add(name)
      continue
    }
    const optionValue = args[index + 1]
    if (!optionValue || optionValue.startsWith("--")) {
      throw new Error(`参数 --${name} 缺少值`)
    }
    values.set(name, optionValue)
    index += 1
  }
  return { flags, values, positionals }
}

function optionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} 必须为正整数`)
  return parsed
}

function optionalDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value)
  if (!match) throw new Error("--max-runtime 必须是正整数或带 ms/s/m/h 后缀的时长")
  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("--max-runtime 必须大于零")
  const multiplier = match[2] === "h" ? 3_600_000
    : match[2] === "m" ? 60_000
      : match[2] === "s" ? 1_000
        : 1
  return amount * multiplier
}
