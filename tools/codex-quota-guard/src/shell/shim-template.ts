import { createHash, timingSafeEqual } from "node:crypto"

export type ShimEntry = "codex" | "codex-raw"

export interface ShimTemplateOptions {
  platform: NodeJS.Platform
  nodeExecutable: string
  cliEntry: string
  entry: ShimEntry
}

export function shimFileName(entry: ShimEntry, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${entry}.cmd` : entry
}

export function renderShim(options: ShimTemplateOptions): string {
  const windows = options.platform === "win32"
  const canonical = windows
    ? renderWindowsPayload(options)
    : renderPosixPayload(options)
  const checksum = createHash("sha256").update(canonical).digest("hex")
  const separator = windows ? "\r\n" : "\n"
  const lines = canonical.split(separator)
  lines.splice(4, 0, windows ? `rem checksum=${checksum}` : `# checksum=${checksum}`)
  return lines.join(separator)
}

export function verifyShim(content: string, options: ShimTemplateOptions): boolean {
  const expected = Buffer.from(renderShim(options))
  const actual = Buffer.from(content)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function renderPosixPayload(options: ShimTemplateOptions): string {
  return [
    "#!/bin/sh",
    "# codex-quota-guard-shim",
    "# format=1",
    `# entry=${options.entry}`,
    `exec ${quotePosix(options.nodeExecutable)} ${quotePosix(options.cliEntry)} __shim ${options.entry} "$@"`,
    "",
  ].join("\n")
}

function renderWindowsPayload(options: ShimTemplateOptions): string {
  return [
    "@echo off",
    "rem codex-quota-guard-shim",
    "rem format=1",
    `rem entry=${options.entry}`,
    `${quoteCmd(options.nodeExecutable)} ${quoteCmd(options.cliEntry)} __shim ${options.entry} %*`,
    "",
  ].join("\r\n")
}

function quotePosix(value: string): string {
  if (value.includes("\0") || value.includes("\n")) {
    throw new Error("shim 路径包含不安全字符")
  }
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function quoteCmd(value: string): string {
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new Error("shim 路径包含不安全字符")
  }
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`
}
