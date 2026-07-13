# Codex Quota Guard

Codex Quota Guard 是一个本地终端工具。它通过官方 `codex app-server` 读取 ChatGPT/Codex 额度，并作为 App Server 客户端启动和监控单个 Codex turn。

工具不抓取 ChatGPT 网页，不读取或复制认证 token，不调用未记录的私有 HTTP 接口，也不会为了生成阈值报告而额外调用模型。

`0.2.0` 在既有一次性 5 小时额度边沿保护上增加了不可静默切换的 Codex 可执行文件解析、运行环境漂移检测、五级能力证据、Goal 安全降级和可审计中断时延。

## 运行环境

- Node.js 20 或更高版本。
- 能运行 `app-server` 且通过本工具现场 schema 与运行时检查的 Codex。
- 已使用 ChatGPT 账户登录 Codex；API key 模式可能没有 ChatGPT 额度窗口。

源码安装与构建：

```bash
cd tools/codex-quota-guard
npm install
npm run typecheck
npm test
npm run build
```

从 npm tarball 临时安装：

```bash
npm pack --pack-destination /private/tmp
npm install --prefix /private/tmp/codex-quota-guard-prefix \
  /private/tmp/codex-quota-guard-0.2.0.tgz --ignore-scripts
/private/tmp/codex-quota-guard-prefix/bin/codex-quota-guard --help
```

卸载临时安装：

```bash
npm uninstall --prefix /private/tmp/codex-quota-guard-prefix codex-quota-guard
```

从需要保护的仓库根目录运行，使 `.codex-guard/state.json` 写入该仓库：

```bash
node /绝对路径/llm_wiki/tools/codex-quota-guard/dist/src/cli.js status
```

也可以在工具目录执行 `npm link`，之后使用 `codex-quota-guard` 命令；卸载时执行 `npm unlink -g codex-quota-guard`。

## Codex 可执行文件选择

所有 `status`、`doctor`、`run` 和 `resume` 命令使用同一个 resolver，优先级固定为：

1. 本次命令的 `--codex-path <路径>`；
2. 环境变量 `CODEX_QUOTA_GUARD_CODEX_PATH`；
3. 当前项目 `.codex-guard/config.json` 中的 `codexPath`；
4. `PATH` 中的 `codex`。

示例：

```bash
codex-quota-guard doctor --codex-path "/Applications/ChatGPT.app/Contents/Resources/codex"
CODEX_QUOTA_GUARD_CODEX_PATH="/绝对路径/codex" codex-quota-guard doctor
```

项目配置示例：

```json
{
  "codexPath": "/绝对路径/codex"
}
```

resolver 会验证绝对路径、普通文件、执行权限、`--version` 和 `app-server --help`，并记录真实路径。显式来源失败时绝不回退到其他二进制。macOS 的 ChatGPT 应用内置 Codex 只作为候选提示；若 `PATH` 没有 Codex，工具不会在用户不知情时自动启动该候选，必须用 `--codex-path`、环境变量或项目配置明确选择。`PATH` Codex 与应用内置 Codex 可能具有不同版本和协议指纹，应以 `doctor` 的实际输出为准。

## 命令

查看额度：

```bash
codex-quota-guard status
codex-quota-guard status --json
```

启动一个受保护的 turn：

```bash
codex-quota-guard run "检查当前仓库"
codex-quota-guard run "继续处理" --thread <threadId>
codex-quota-guard run "执行目标" --goal "完成目标" --token-budget 20000
codex-quota-guard run "限时任务" --max-runtime 30m --max-turns 3
codex-quota-guard run "必须受保护的任务" --require-protection
codex-quota-guard run "严格 Goal 任务" --goal "完成目标" --require-goal-control
```

默认情况下，App Server 暂时不返回 5 小时窗口时仍允许 `run`。只有显式使用 `--require-protection` 才会在 `thread/start` 前启用严格准入；没有关联中断记录的其他命令仍保持默认行为。

若严格 run 成功启动并随后因额度边沿被中断，严格保护策略会写入本地状态并由该中断记录的 `resume` 继承。严格模式在 5 小时窗口不可用或仍处于 `awaiting baseline` 时都拒绝新 turn；默认模式仍保持放行。

恢复最近一次因 5 小时额度阈值而中断的同一 thread：

```bash
codex-quota-guard resume
codex-quota-guard resume "从中断点继续"
codex-quota-guard resume "继续严格任务" --require-goal-control
```

无提示的 `resume` 只恢复 thread 和原 Goal；带提示时再启动一个新 turn。没有可恢复记录时会明确提示改用 `run`。`resume` 不会为同一个 5 小时额度窗口重新布防。

检查本机协议：

```bash
codex-quota-guard doctor
codex-quota-guard doctor --json
```

`doctor` 会用同一个 resolver 选择 Codex，在系统临时目录运行 `codex app-server generate-json-schema --experimental`，检查所需方法，再完成 App Server 握手和 `account/rateLimits/read`。它不会调用 `turn/start`。

文本和 JSON 结果会显示所选路径、真实路径、选择来源、版本、协议指纹、握手、额度读取，以及 `turn/start`、`turn/interrupt`、`thread/read`、Goal get/pause/resume、后台 terminal 清理和双向服务器请求处理等逐项能力。

能力状态分为 `unavailable`、`schemaDetected`、`runtimeVerified`、`degraded` 和 `failed`。`schemaDetected` 只表示当前生成的协议中存在该能力，不等于运行时已经成功。普通 doctor 只把真实握手和额度读取标为运行时已验证；不会为了美化结果调用模型。未知版本不会被静默视为兼容，工具只根据该版本现场生成的 schema 给出能力结论并标明降级。

`status --json` 在保留原有 `schemaVersion`、额度、guard、turn、active 和 limits 字段的同时，增加 `executable`、`protocolFingerprint`、`capabilities`、`goalControl` 和 `runtimeChanges`。恢复任务时若路径、真实路径、版本或协议指纹发生变化，旧的 `runtimeVerified` 证据会失效，并根据当前 RuntimeContext 重新检查核心保护能力。

## 5 小时保护窗口

保护器只使用 `windowDurationMins === 300` 识别 5 小时窗口，不根据 `primary` 或 `secondary` 名称猜测窗口含义。

- `protectedRemainingPercent`：只来自唯一有效的 300 分钟窗口，只由它决定是否触发一次性中断。
- `overallRemainingPercent`：所有有效窗口中的最低剩余，只用于显示和诊断。
- weekly 或任何非 300 分钟窗口无论多低都不会触发 `turn/interrupt`。
- 找不到可唯一识别且带 `resetsAt` 的 300 分钟窗口时，不回退到 weekly 或其他窗口：文本显示 `5h protection: UNAVAILABLE`、`guard: DORMANT`、`turns: ALLOWED`，weekly 继续显示 used/left，且不再用笼统的 `quota: UNKNOWN` 描述这一正常降级状态。
- JSON 顶层 `protectedWindow` 提供 `available`、`reason` 和 `awaitingBaseline`，用于区分能力不可用、数据过期和冷启动等待基线。
- 每次额度更新、主动刷新和 App Server 重连都会重新查找 300 分钟窗口；窗口重新出现时按其 `limitId`、窗口长度和 `resetsAt` 恢复或重新布防。

示例：

```text
5h: 98.2% used · 1.8% left · 5h (windowDurationMins=300) · resets ...
weekly: 66% used · 34% left · weekly (7d, windowDurationMins=10080) · resets ...
quota: CRITICAL (1.8% left) · overall: 1.8% left · guard: HANDLED · turns: ALLOWED
```

## 一次性边沿语义

保护状态与额度严重度相互独立：

- `ARMED`：当前 5 小时窗口尚未处理阈值。
- `HANDLING`：已原子固定触发瞬间的 `threadId` 和 `turnId`，正在处理中断。
- `HANDLED`：当前 5 小时窗口已经处理一次，不得再次中断。
- `DORMANT`：当前快照暂时没有可用的 5 小时窗口；不会用 weekly 替代，也不限制新 turn。
- `UNKNOWN`：快照缺失、无效或已经过期，无法建立可信的额度状态。

只有在 5 小时窗口剩余第一次从高于 2% 下降到不高于 2% 时才产生事件。事件先持久化固定的原 turn，再只对该 turn 调用 `turn/interrupt`。事件之后启动或恢复的 turn 永远不会成为旧事件的中断目标。

同一 5 小时窗口进入 `HANDLED` 后，即使额度仍不高于 2%，后续 `run`、`resume` 和新 turn 仍为 `ALLOWED`。本工具没有全局硬停止 latch，也不使用 `STOPPED` 表示整个系统。

只有以下情况重新布防：

- 5 小时窗口的 `resetsAt` 改变；
- 确认进入新的 5 小时窗口；
- 5 小时额度先恢复到高于 5%。

weekly 的额度或 `resetsAt` 变化不会重新布防。

5 小时窗口暂时消失不会清除同一 `windowKey` 已有的 `HANDLED` 记录。它以相同 key 返回时仍为 `HANDLED`；新 key 出现时自动进入 `ARMED`。新窗口首次出现时只建立观察基线，只有后续实际观察到从高于 2% 下降到不高于 2% 才触发。

若首次观察到的 5 小时窗口已经不高于 2%，工具不会把“首次看到”伪装成下降沿，也不会中断 active turn；状态显示 `awaiting baseline`。同一窗口恢复到高于 5% 后建立安全基线，之后再次从高于 2% 跨到不高于 2% 才触发一次。

## 严重度与准入

- `SAFE`：5 小时剩余大于 5%。
- `WARNING`：大于 3% 且不高于 5%。
- `LOW`：大于 2% 且不高于 3%。
- `CRITICAL`：不高于 2%。
- `UNKNOWN`：没有可信的 5 小时额度数据或数据已过期。

`WARNING` 和 `LOW` 只提示，不限制任务规模或新 turn。本工具没有 `--small`，也不根据提示词猜测任务大小。credits 会显示，但不会绕过 5 小时额度保护。

`UNKNOWN` 影响额度数据可信度准入；`DORMANT` 则明确放行。两者都不会抹掉已经持久化的 `HANDLED` 事实。

## Goal 与其他保护层

阈值事件会保存原 Goal，并在当前协议支持时将其设为 `paused`。`resume` 恢复原 objective、status 和 tokenBudget。任何路径都不会调用 `thread/goal/clear`。

Goal 控制与额度中断保护相互独立。Goal schema 存在但数据库或运行时不可用时，工具先完成固定目标的精确 `turn/interrupt`，再把 `goalControl` 记为 `degraded` 并保存 `goal_database_unavailable`、`goal_schema_unavailable` 或 `goal_runtime_failed`；不会伪造已暂停，也不会清除 Goal。`--require-protection` 只要求额度读取与精确中断能力。只有显式使用 `--require-goal-control` 时，Goal pause/resume 运行时验证失败才会在 `turn/start` 前拒绝任务。

以下保护分别记录，不互相换算：

- ChatGPT 账户的 5 小时额度保护；
- Goal tokenBudget；
- 可选最大运行时间；
- 可选最大 turn 数量。

## 持久化与安全

- 状态：`.codex-guard/state.json`。
- 报告：`.codex-guard/reports/<eventId>.json` 和 `.md`。
- 控制器锁：`.codex-guard/controller.lock`。

状态使用临时文件、文件同步和原子重命名。进程锁带心跳和崩溃锁接管。状态与报告会移除 token、cookie、authorization、secret 和 API key 等敏感字段。

本地报告只包含阈值事件、固定 turn、额度快照、已完成 item 摘要、错误和 Git 状态，不调用模型生成停止总结。报告把真实额度事件标为 `quotaThreshold`，把显式 canary 标为 `liveCanary`，并保存可用的 UTC 时间及由单调时钟计算的请求时延；缺少通知或对账证据时对应字段保持 `null`。

## 测试

```bash
npm run format:check
npm run typecheck
npm test
npm run build
```

所有自动化测试均使用 fake App Server transport。`npm test` 不启动真实 Codex，不访问真实账户，也不调用真实 `turn/start`。

仓库 CI 在 macOS、Linux 和 Windows 上使用 Node.js 20.19 运行安装、依赖树、格式、类型、全部 fake transport 测试、构建和打包检查。子进程测试会通过 `process.execPath` 启动含空格路径中的 fake App Server；进程锁和原子状态写入测试使用各平台系统临时目录。Linux 和 Windows CI 证明跨平台 resolver 与控制逻辑，不证明当地存在真实 ChatGPT 登录或额度窗口；真实 App Server 兼容性由 macOS 上的普通 doctor 安全探测记录。

控制器还覆盖快速 turn 竞态：即使 `turn/completed` 早于 `turn/start` 响应到达，`waitForTurn` 仍返回服务端真实状态，不会因为错过通知而误发超时中断。失败 turn 的错误会写入本地状态，命令以非零状态退出。

部分 App Server 版本可能让 `turn/start` 响应 ID 与 `turn/started`、`thread/read` 使用的运行时 turn ID 不同。控制器会优先保存唯一 `inProgress` turn 的运行时 ID，确保后续额度中断、完成通知和持久状态指向同一个 turn；无法唯一对账时才回退到响应 ID。

## `doctor --live-canary`

普通 `doctor` 和自动测试始终保持零真实 turn。live canary 会消耗一次极小真实模型调用，必须同时提供显式参数和完全匹配的确认变量：

```bash
CODEX_QUOTA_GUARD_LIVE_CANARY=I_ACCEPT_MODEL_USAGE codex-quota-guard doctor --live-canary
```

执行器会先生成并检查当前 schema；缺少任一必要能力时不会调用 `turn/start`。通过后创建专用 thread，先执行不消耗模型的 Goal set/get、paused 读取确认和恢复预检；预检失败时直接停止，`turn/start` 保持未测试。只有全部预检成功才调用一次极小 turn。它会在发送 `turn/start` 前订阅 `turn/started`，以通知中的精确 `threadId`/`turnId` 立即发出 `turn/interrupt`，避免快速 turn 在响应返回后已经结束的竞态。`turn/started` 等待上限为 15 秒；若通知缺失，则使用已知 `threadId` 调用 `thread/read`，只有恰好找到一个 `inProgress` turn 时才按其精确 ID 中断，否则明确失败且不盲目选择。通知或 `thread/read` 得到的运行时 ID 是中断依据，不要求它与 `turn/start` 响应 ID 相同。中断后使用匹配的完成通知或精确 `thread/read` 对账记录终态，并清理后台 terminal。失败路径尽最大努力恢复 Goal，绝不启动第二个 turn 或自动重试。结果写入 `liveCanary`、审计时延和能力矩阵，不用于账户额度保护判断。

## 已知限制

- App Server 只在服务端推送或主动轮询得到新快照后，工具才能观察额度变化。网络延迟、服务端取整和快照刷新粒度意味着无法在数学意义上保证恰好停在 `2.000%`；保证的是首次观察到“先前高于 2%，当前不高于 2%”后，原子固定并中断当时的 active turn。
- Goal 和后台 terminal 清理在 `codex-cli 0.131.0` 中需要 `experimentalApi`。缺失时工具保留 turn 中断，记录协议降级，且绝不以清除 Goal 代替暂停。
- `codex-cli 0.131.0` 的 Goal 仍是默认关闭的实验功能，工具使用公开的 `--enable goals` 启动 App Server。schema 中存在 Goal 方法和 paused 状态并不证明本机 Goal 数据库可用；`doctor --live-canary` 会把 `no such table: thread_goals` 等运行时问题准确标为失败，不会修改用户的 Codex 数据库来伪造通过。
- 首版没有交互式审批界面。App Server 发来的命令审批、文件审批、用户输入等双向 JSON-RPC 请求会收到明确的“不支持”错误并写入本地诊断，而不是被误当成响应后静默挂起；因此需要交互批准的 turn 会失败并以非零状态退出。
- 首版是单轮控制器，不是长任务编排器。每次 `run` 或带提示的 `resume` 最多启动一个 turn。
- 工具只能可靠控制由自身 App Server 会话创建或续接的 thread，不能安全附加到独立、不可控制的 Codex CLI 进程。
- 若协议同时返回多个可用于保护的 300 分钟窗口，工具按能力暂不可用处理并显示 `DORMANT`，不会任意选择 primary 或 secondary。
- `doctor` 在 App Server 和额度读取正常、但快照只有 weekly 等非 5 小时窗口时返回 `degraded` 而不是 `failed`；这表示当前无法提供 5 小时保护，不表示工具或额度读取失败。
