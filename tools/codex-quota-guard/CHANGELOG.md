# 变更记录

## 0.2.0

- 新增统一 Codex 可执行文件 resolver，固定采用命令行参数、环境变量、项目配置、`PATH` 的优先级；macOS 应用内置二进制只作为候选提示，绝不静默启动或回退。
- 新增路径存在性、执行权限、`--version`、`app-server --help`、真实路径和协议指纹验证，并让 `status`、`doctor`、`run`、`resume` 共享同一个 `RuntimeContext`。
- `doctor` 和稳定 JSON 输出新增实际路径、选择来源、版本、协议指纹、握手、额度读取和五级能力证据，明确区分 `schemaDetected` 与 `runtimeVerified`。
- 任务状态保存创建时与当前运行环境；`resume` 发现路径、版本或协议指纹变化时使旧运行时证据失效，并重新检查精确中断等核心能力。
- Goal 数据库或运行时不可用时安全降级为 `goalControl: degraded`，不阻止固定目标的精确中断，不伪造暂停且绝不调用 Goal clear；新增显式 `--require-goal-control` 严格模式。
- 阈值事件和显式 live canary 新增 UTC 审计时间与单调时钟时延；缺少通知或精确对账证据时保持 `null`。
- 状态、报告、resolver 错误和 App Server 诊断统一脱敏 `token`、`cookie`、`authorization`、`secret` 与 API key。
- 保持原有兼容保证：只有唯一有效的 300 分钟窗口可触发一次性中断；weekly 永不触发；`HANDLED` 后新任务继续允许；5 小时窗口不可见时为 `DORMANT + ALLOWED`。

## 0.1.0

- 首个可用版本：本地额度显示、单轮受保护 turn、一次性 5 小时阈值中断、持久状态、进程锁、Goal 恢复和 fake App Server 测试。
