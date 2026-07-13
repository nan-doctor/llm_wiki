# Codex Quota Guard 0.3.0 发布检查清单

## 范围与安全

- [ ] 变更仅位于 `tools/codex-quota-guard/**`、`docs/codex-quota-guard-plan.md` 和专属 workflow。
- [ ] 没有修改仓库根 TypeScript、Vitest 或 package 配置。
- [ ] 自动测试全部使用 fake App Server，不调用真实模型。
- [ ] 本轮未执行真实 live canary；如需执行，必须重新取得显式授权并保留双重确认。
- [ ] 状态、报告、错误和诊断的敏感样例均通过脱敏测试。
- [ ] npm 安装没有静默创建 `codex`、`codex-raw`、profile 块或全局 Guard 配置。
- [ ] 真实 Codex 二进制和 `~/.codex/config.toml` 前后 SHA-256 不变。

## 本地质量门

- [ ] `npm ci --ignore-scripts --cache /private/tmp/codex-quota-guard-npm-cache`
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run format:check`
- [ ] `npm run build`
- [ ] `npm ls --depth=0`
- [ ] `npm pack --dry-run --cache /private/tmp/codex-quota-guard-npm-cache`
- [ ] `git diff --check`

## 打包与仓库外冒烟

- [ ] 生成 `codex-quota-guard-0.3.0.tgz` 并安装到临时 prefix。
- [ ] 从仓库外目录运行 `codex-quota-guard --help`。
- [ ] 从仓库外目录运行 `codex-quota-guard status --json`。
- [ ] 从仓库外目录运行普通 `codex-quota-guard doctor --json`。
- [ ] 验证默认 `PATH` 来源为 `path`。
- [ ] 验证 `--codex-path` 来源为 `cli`。
- [ ] 验证 `CODEX_QUOTA_GUARD_CODEX_PATH` 来源为 `environment`。
- [ ] 验证项目配置来源为 `config`，且不污染其他目录。
- [ ] tarball 包含 README、CHANGELOG、RELEASE_CHECKLIST 与 dist，不含测试、状态或认证文件。

## 默认终端与 shell 集成

- [ ] macOS zsh、macOS bash、Linux zsh、Linux bash 和 Windows PowerShell 分支测试通过。
- [ ] install 显示全部文件并要求精确输入 `INSTALL`；非 TTY 零写入。
- [ ] 只修改当前 shell profile，其他 shell 与 Codex 配置哈希不变。
- [ ] `shell status` 检查 profile、shim checksum、保存路径、版本漂移和 PATH 首位。
- [ ] `codex` 解析到受管 shim；无参数打开原生 TUI，任务只在 TUI 内输入。
- [ ] `codex-raw`、`codex raw` 和单次 BYPASS 使用保存的真实绝对路径。
- [ ] 管理 allowlist 透明转发；`exec` 和未知命令不会静默旁路。
- [ ] uninstall 要求精确输入 `UNINSTALL`，恢复 profile/PATH，重复执行幂等且零 shim 残留。

## 透明代理与本地安全边界

- [ ] TUI 请求、响应、通知、App Server 主动请求、审批、未知方法和扩展字段双向保真。
- [ ] Guard ID 与 TUI 数字/字符串 ID 不冲突，未知响应不会误配。
- [ ] macOS/Linux 使用权限受限 Unix socket；Windows 只监听 `127.0.0.1`。
- [ ] capability token 不在命令行、日志、状态、报告、配置、token 文件或上游环境中。
- [ ] fake edge 只中断 first turn，second turn 放行；重复 updated 不重复中断。
- [ ] fake weekly-only 保持 `DORMANT + ALLOWED` 且中断数为零。
- [ ] TUI 正常退出、TUI 断线、App Server 崩溃和 `SIGINT` 均清理 socket、TUI 和 App Server。

## 行为回归

- [ ] 只有 `windowDurationMins === 300` 的窗口触发保护。
- [ ] weekly 和其他窗口永不触发 `turn/interrupt`。
- [ ] 仅首次从高于 2% 降到不高于 2% 时中断固定的原 turn。
- [ ] 同一 windowKey 最多处理一次，`HANDLED` 后新 turn 仍允许。
- [ ] 5 小时窗口不可见时为 `DORMANT + ALLOWED`，不拿 weekly 替代。
- [ ] `--require-protection` 在保护不可用或等待基线时拒绝。
- [ ] Goal 降级不阻止精确中断，且从不调用 Goal clear。
- [ ] `quota`、`guard`、`turns` 分开显示，不使用误导性的全局 `STOPPED`。

## 真实环境与持续集成

- [ ] 记录 `PATH` Codex 的路径、真实路径、版本、协议指纹、握手、额度读取和能力矩阵。
- [ ] 记录 ChatGPT 应用内置 Codex 的同等普通 doctor 结果。
- [ ] 记录所有未验证的真实运行假设和限制。
- [ ] 完成真实 Codex 无模型 remote TUI 首屏验收：不输入 prompt、不执行 slash command、不启动 turn。
- [ ] 验收后 `config.toml` 哈希、App Server PID 集合和临时 socket/token 残留检查通过。
- [ ] 最终提交对应的 macOS、Ubuntu、Windows workflow 全部成功。
