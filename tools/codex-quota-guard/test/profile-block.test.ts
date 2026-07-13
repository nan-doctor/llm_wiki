import { describe, expect, it } from "vitest"
import {
  addProfileBlock,
  inspectProfile,
  profileBlock,
  removeProfileBlock,
} from "../src/shell/profile-block.js"

describe("profile 标记块", () => {
  it.each([
    ["zsh", "export PATH='/path with spaces/shims':\"$PATH\""],
    ["bash", "export PATH='/path with spaces/shims':\"$PATH\""],
    ["powershell", "$env:PATH = '/path with spaces/shims;' + $env:PATH"],
  ] as const)("为 %s 生成唯一完整块", (shell, middle) => {
    const block = profileBlock(shell, "/path with spaces/shims")
    expect(block).toContain("# >>> codex-quota-guard shell integration >>>")
    expect(block).toContain(middle)
    expect(block).toContain("# <<< codex-quota-guard shell integration <<<")
  })

  it("追加一次、完整块幂等并能精确恢复前后用户内容", () => {
    const original = "before\nuser content"
    const installed = addProfileBlock(original, "zsh", "/shims")

    expect(addProfileBlock(installed, "zsh", "/shims")).toBe(installed)
    expect(inspectProfile(installed, "zsh", "/shims").status).toBe("managed")
    expect(removeProfileBlock(installed, "zsh", "/shims")).toBe(original)

    const withLaterUserContent = `${installed}later user content\n`
    expect(removeProfileBlock(withLaterUserContent, "zsh", "/shims"))
      .toBe(`${original}\nlater user content\n`)
  })

  it("POSIX profile 对单引号路径使用 shell 安全引用", () => {
    expect(profileBlock("zsh", "/user's/shims"))
      .toContain("export PATH='/user'\\''s/shims':\"$PATH\"")
  })

  it.each([
    ["# >>> codex-quota-guard shell integration >>>\n", "partial"],
    ["# <<< codex-quota-guard shell integration <<<\n", "partial"],
    [`${profileBlock("zsh", "/shims")}\n${profileBlock("zsh", "/shims")}\n`, "duplicate"],
    [profileBlock("zsh", "/other"), "modified"],
  ] as const)("识别不安全块为 %s", (content, status) => {
    expect(inspectProfile(content, "zsh", "/shims").status).toBe(status)
    expect(() => addProfileBlock(content, "zsh", "/shims")).toThrow()
    expect(() => removeProfileBlock(content, "zsh", "/shims")).toThrow()
  })
})
