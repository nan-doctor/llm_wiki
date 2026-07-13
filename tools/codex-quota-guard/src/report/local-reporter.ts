import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { PersistedGuardState } from "../guard/state-machine.js"
import { sanitizeForPersistence } from "../persistence/state-store.js"
import type { ThresholdReporter } from "./reporter.js"

const execFileAsync = promisify(execFile)

export interface LocalReporterOptions {
  inspectGit?: () => Promise<string>
}

export class LocalThresholdReporter implements ThresholdReporter {
  constructor(
    private readonly rootDirectory: string,
    private readonly options: LocalReporterOptions = {},
  ) {}

  async write(state: PersistedGuardState): Promise<void> {
    const event = state.lastThresholdEvent
    if (!event) return
    const reportsDirectory = path.join(this.rootDirectory, ".codex-guard", "reports")
    await mkdir(reportsDirectory, { recursive: true, mode: 0o700 })
    const rawGitStatus = await (this.options.inspectGit ?? (() => inspectGit(this.rootDirectory)))()
    const gitStatus = sanitizeForPersistence(rawGitStatus) as string
    const report = sanitizeForPersistence({
      schemaVersion: 1,
      generatedAt: Date.now(),
      event,
      quota: state.quota,
      completedItems: state.completedItems,
      errors: state.errors,
      gitStatus,
    })
    const json = `${JSON.stringify(report, null, 2)}\n`
    const markdown = renderMarkdown(state, gitStatus)
    await Promise.all([
      writeFile(path.join(reportsDirectory, `${event.id}.json`), json, { mode: 0o600 }),
      writeFile(path.join(reportsDirectory, `${event.id}.md`), markdown, { mode: 0o600 }),
    ])
  }
}

async function inspectGit(rootDirectory: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--branch"], {
      cwd: rootDirectory,
      encoding: "utf8",
    })
    return stdout.trimEnd()
  } catch (error) {
    return `Git 状态读取失败：${error instanceof Error ? error.message : String(error)}`
  }
}

function renderMarkdown(state: PersistedGuardState, gitStatus: string): string {
  const event = state.lastThresholdEvent!
  const target = event.target
    ? `${event.target.threadId} / ${event.target.turnId}`
    : "无 active turn"
  const items = state.completedItems.length === 0
    ? "- 无"
    : state.completedItems.map((item) => `- ${String(item.type ?? "unknown")} · ${String(item.id ?? "unknown")}`).join("\n")
  const errors = sanitizeForPersistence([...state.errors, ...event.errors]) as string[]
  return `# Codex Quota Guard 本地阈值报告

- 事件：${event.id}
- 事件类型：${event.audit.eventKind}
- 时间：${new Date(event.occurredAt).toISOString()}
- 窗口：${event.windowKey}
- 固定目标：${target}
- 中断成功：${String(event.interruptSucceeded)}
- Goal 已暂停：${String(event.goalPaused)}
- 后台 terminal 已清理：${String(event.backgroundTerminalsCleaned)}
- quotaSnapshotObservedAt：${event.audit.quotaSnapshotObservedAt ?? "null"}
- thresholdDetectedAt：${event.audit.thresholdDetectedAt ?? "null"}
- activeTurnResolvedAt：${event.audit.activeTurnResolvedAt ?? "null"}
- interruptRequestedAt：${event.audit.interruptRequestedAt ?? "null"}
- interruptAcknowledgedAt：${event.audit.interruptAcknowledgedAt ?? "null"}
- turnTerminalStateObservedAt：${event.audit.turnTerminalStateObservedAt ?? "null"}
- goalPauseRequestedAt：${event.audit.goalPauseRequestedAt ?? "null"}
- goalPauseAcknowledgedAt：${event.audit.goalPauseAcknowledgedAt ?? "null"}
- backgroundTerminalCleanedAt：${event.audit.backgroundTerminalCleanedAt ?? "null"}
- snapshotToDetectionMs：${event.audit.latencies.snapshotToDetectionMs ?? "null"}
- detectionToInterruptRequestMs：${event.audit.latencies.detectionToInterruptRequestMs ?? "null"}
- interruptRequestToAcknowledgementMs：${event.audit.latencies.interruptRequestToAcknowledgementMs ?? "null"}
- interruptRequestToTerminalStateMs：${event.audit.latencies.interruptRequestToTerminalStateMs ?? "null"}

## 已完成 item

${items}

## 错误

${errors.length === 0 ? "- 无" : errors.map((error) => `- ${error}`).join("\n")}

## Git 状态

\`\`\`text
${gitStatus || "工作树干净"}
\`\`\`
`
}
