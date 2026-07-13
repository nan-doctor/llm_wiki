#!/usr/bin/env node

const args = process.argv.slice(2)

if (args.includes("app-server")) {
  await import("./fake-jsonl-app-server.mjs")
} else if (args.includes("--remote")) {
  await import("./fake-remote-tui.mjs")
} else if (args.includes("--version")) {
  process.stdout.write("codex-cli fake-e2e\n")
} else if (args.includes("--help")) {
  process.stdout.write("Usage: codex --remote <endpoint> --remote-auth-token-env <name>\n")
} else {
  process.stderr.write("fake codex：不支持的参数\n")
  process.exitCode = 2
}
