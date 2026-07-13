import type { ShimEntry } from "./shim-template.js"

export type ShimRoute =
  | { kind: "interactive"; tuiArgs: string[] }
  | {
      kind: "raw"
      args: string[]
      reason: "codex-raw" | "explicit-raw" | "bypass"
    }
  | { kind: "management"; args: string[] }
  | { kind: "version" }
  | { kind: "reject-exec" }
  | { kind: "unknown"; args: string[] }
  | { kind: "reject"; message: string }

const MANAGEMENT_COMMANDS = new Set([
  "login",
  "logout",
  "mcp",
  "app-server",
  "completion",
  "plugin",
  "mcp-server",
  "remote-control",
  "update",
  "doctor",
  "features",
])

export function routeShim(
  entry: ShimEntry,
  args: string[],
  environment: Readonly<Record<string, string | undefined>>,
): ShimRoute {
  if (entry === "codex-raw") {
    return { kind: "raw", args: [...args], reason: "codex-raw" }
  }
  if (environment.CODEX_QUOTA_GUARD_BYPASS === "1") {
    return { kind: "raw", args: [...args], reason: "bypass" }
  }
  if (args[0] === "raw") {
    return { kind: "raw", args: args.slice(1), reason: "explicit-raw" }
  }
  if (args.length === 1 && args[0] === "--version") return { kind: "version" }

  const command = args[0]
  if (command && MANAGEMENT_COMMANDS.has(command)) {
    return { kind: "management", args: [...args] }
  }
  if (command === "exec") return { kind: "reject-exec" }
  if (args.length === 0 || command?.startsWith("-")) {
    if (args.some(isGuardOwnedRemoteArgument)) {
      return {
        kind: "reject",
        message: "remote 连接参数由 Codex Quota Guard 独占，拒绝覆盖",
      }
    }
    return { kind: "interactive", tuiArgs: [...args] }
  }
  return { kind: "unknown", args: [...args] }
}

function isGuardOwnedRemoteArgument(value: string): boolean {
  return value === "--remote"
    || value.startsWith("--remote=")
    || value === "--remote-auth-token-env"
    || value.startsWith("--remote-auth-token-env=")
}
