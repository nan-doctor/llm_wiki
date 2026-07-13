export type ParsedCliArgs =
  | { command: "help" }
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
