import type { SupportedShell } from "../persistence/global-config-store.js"

const START_MARKER = "# >>> codex-quota-guard shell integration >>>"
const END_MARKER = "# <<< codex-quota-guard shell integration <<<"

export type ProfileInspectionStatus =
  | "absent"
  | "managed"
  | "partial"
  | "duplicate"
  | "modified"

export interface ProfileInspection {
  status: ProfileInspectionStatus
  block: string
}

export function profileBlock(
  shell: SupportedShell,
  shimDirectory: string,
): string {
  const quoted = shell === "powershell"
    ? quotePowerShellSingle(shimDirectory)
    : quotePosixSingle(shimDirectory)
  const pathLine = shell === "powershell"
    ? `$env:PATH = '${quoted};' + $env:PATH`
    : `export PATH='${quoted}':"$PATH"`
  return [START_MARKER, pathLine, END_MARKER].join("\n")
}

export function inspectProfile(
  content: string,
  shell: SupportedShell,
  shimDirectory: string,
): ProfileInspection {
  const expected = profileBlock(shell, shimDirectory)
  const starts = occurrences(content, START_MARKER)
  const ends = occurrences(content, END_MARKER)
  if (starts === 0 && ends === 0) return { status: "absent", block: expected }
  if (starts !== ends) return { status: "partial", block: expected }
  if (starts !== 1) return { status: "duplicate", block: expected }
  if (!content.includes(expected)) return { status: "modified", block: expected }
  return { status: "managed", block: expected }
}

export function addProfileBlock(
  content: string,
  shell: SupportedShell,
  shimDirectory: string,
): string {
  const inspection = inspectProfile(content, shell, shimDirectory)
  if (inspection.status === "managed") return content
  assertSafeProfileStatus(inspection.status)
  return `${content}\n${inspection.block}\n`
}

export function removeProfileBlock(
  content: string,
  shell: SupportedShell,
  shimDirectory: string,
): string {
  const inspection = inspectProfile(content, shell, shimDirectory)
  if (inspection.status === "absent") return content
  assertSafeProfileStatus(inspection.status)
  if (content === inspection.block) return ""
  const installedSegment = `\n${inspection.block}\n`
  const index = content.indexOf(installedSegment)
  if (index === -1) {
    throw new Error("profile 中的受管标记块位置已被修改，拒绝自动删除")
  }
  const before = content.slice(0, index)
  const after = content.slice(index + installedSegment.length)
  if (!before || !after) return `${before}${after}`
  return `${before}\n${after}`
}

function assertSafeProfileStatus(status: ProfileInspectionStatus): void {
  if (status === "absent" || status === "managed") return
  throw new Error(`profile 标记块不安全：${status}`)
}

function occurrences(content: string, needle: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const found = content.indexOf(needle, offset)
    if (found === -1) return count
    count += 1
    offset = found + needle.length
  }
}

function quotePowerShellSingle(value: string): string {
  return value.replaceAll("'", "''")
}

function quotePosixSingle(value: string): string {
  return value.replaceAll("'", `'\\''`)
}
