# Codex Quota Guard 0.2.0 发布检查清单

## 范围与安全

- [ ] 变更仅位于 `tools/codex-quota-guard/**`、`docs/codex-quota-guard-plan.md` 和专属 workflow。
- [ ] 没有修改仓库根 TypeScript、Vitest 或 package 配置。
- [ ] 自动测试全部使用 fake App Server，不调用真实模型。
- [ ] 本轮未执行真实 live canary；如需执行，必须重新取得显式授权并保留双重确认。
- [ ] 状态、报告、错误和诊断的敏感样例均通过脱敏测试。

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

- [ ] 生成 `codex-quota-guard-0.2.0.tgz` 并安装到临时 prefix。
- [ ] 从仓库外目录运行 `codex-quota-guard --help`。
- [ ] 从仓库外目录运行 `codex-quota-guard status --json`。
- [ ] 从仓库外目录运行普通 `codex-quota-guard doctor --json`。
- [ ] 验证默认 `PATH` 来源为 `path`。
- [ ] 验证 `--codex-path` 来源为 `cli`。
- [ ] 验证 `CODEX_QUOTA_GUARD_CODEX_PATH` 来源为 `environment`。
- [ ] 验证项目配置来源为 `config`，且不污染其他目录。
- [ ] tarball 包含 README、CHANGELOG、RELEASE_CHECKLIST 与 dist，不含测试、状态或认证文件。

## 行为回归

- [ ] 只有 `windowDurationMins === 300` 的窗口触发保护。
- [ ] weekly 和其他窗口永不触发 `turn/interrupt`。
- [ ] 仅首次从高于 2% 降到不高于 2% 时中断固定的原 turn。
- [ ] 同一 windowKey 最多处理一次，`HANDLED` 后新 turn 仍允许。
- [ ] 5 小时窗口不可见时为 `DORMANT + ALLOWED`，不拿 weekly 替代。
- [ ] `--require-protection` 在保护不可用或等待基线时拒绝。
- [ ] Goal 降级不阻止精确中断，且从不调用 Goal clear。

## 真实环境与持续集成

- [ ] 记录 `PATH` Codex 的路径、真实路径、版本、协议指纹、握手、额度读取和能力矩阵。
- [ ] 记录 ChatGPT 应用内置 Codex 的同等普通 doctor 结果。
- [ ] 记录所有未验证的真实运行假设和限制。
- [ ] 最终提交对应的 macOS、Ubuntu、Windows workflow 全部成功。
