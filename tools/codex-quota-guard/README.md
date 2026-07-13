# Codex Quota Guard

Codex Quota Guard 是一个本地终端工具。它通过官方 `codex app-server` 读取 ChatGPT/Codex 额度，并作为 App Server 客户端启动和监控单个 Codex turn。

工具不抓取 ChatGPT 网页，不读取或复制认证 token，不调用未记录的私有 HTTP 接口，也不会为了生成阈值报告而额外调用模型。

`0.3.0` 增加默认 Codex 终端启动器：用户确认安装当前 shell 的可逆 shim 后，直接输入 `codex` 即可打开受保护的原生 Codex TUI。额度保护规则由工具自动执行，任务提示在 TUI 内输入，不需要在提示词中重复说明额度阈值。

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
  /private/tmp/codex-quota-guard-0.3.0.tgz --ignore-scripts
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

## 默认 Codex 终端启动器

首次安装只在交互式 TTY 中进行：

```bash
codex-quota-guard shell install \
  --codex-path "/Applications/ChatGPT.app/Contents/Resources/codex"
```

安装器先显示将修改的当前 shell profile、全局 Guard 配置、独立 shim 目录和已验证的真实 Codex 绝对路径；只有输入完全匹配的 `INSTALL` 才会写入。macOS 和 Linux 支持当前 zsh 或 bash，Windows 支持当前 PowerShell。它不会顺带修改其他 shell。默认 shim 目录为：

```text
~/.local/share/codex-quota-guard/shims/
```

Windows 使用 `%LOCALAPPDATA%\codex-quota-guard\shims\`。安装器只向当前 profile 追加带固定开始/结束标记的 PATH 块，并原子写入两份带 checksum 的受管 shim。它不会替换、删除或改写真实 Codex 二进制，不会修改 `~/.codex/config.toml`，也不会修改模型、reasoning、sandbox、approval、MCP 或登录设置。npm 安装本身只发布 `codex-quota-guard`，不会静默创建 `codex` 或 `codex-raw`。

安装后，在新 shell 中运行：

```bash
codex
```

这会直接打开原生 Codex TUI。实际任务、slash command、审批和 Goal 操作都在 TUI 内完成；无须在命令行提供任务提示，也无须重复“额度到 2% 时暂停”等规则。直接运行工具入口也等价：

```bash
codex-quota-guard interactive
codex-quota-guard interactive --require-protection
codex-quota-guard interactive -- --model <模型>
```

连接始终采用单上游连接：

```text
原生 Codex TUI
        ↕ 本地、带临时 capability token 的 WebSocket
Codex Quota Guard 透明 JSON-RPC 代理与任务控制器
        ↕ 唯一 stdio 连接
真实 codex app-server
```

Guard 是真实 App Server 的唯一客户端。代理原样转发请求、响应、通知、App Server 主动请求、审批和未知协议字段；Guard 注入请求使用独立 ID 命名空间。所有平台的 endpoint 都只监听 `127.0.0.1` 的随机端口，并拒绝错误 token 和第二个客户端。当前 Codex 明确禁止把 `--remote-auth-token-env` 与 `unix://` 组合，因此不能在保留认证的同时使用 Unix socket。随机 token 只通过临时环境变量交给本次 TUI，不进入命令行、状态、报告、配置、token 文件或上游 App Server 环境；退出后监听端口和内存 token 都会清理。

查看安装完整性或卸载：

```bash
codex-quota-guard shell status
codex-quota-guard shell status --json
codex-quota-guard shell uninstall
```

卸载必须在当前 shell 的 TTY 中输入完全匹配的 `UNINSTALL`。它只删除 checksum 和内容都匹配的受管 shim、当前 shell 的完整标记块；未知文件或被修改的块会保留并报冲突。最后一个 shell 卸载后 shim 目录才删除。重新打开 shell 后，PATH 恢复到安装前的真实 `codex` 解析；重复 install/uninstall 都是幂等的。

若保存的真实 Codex 被移动、删除、失去执行权限、变成 Guard/shim，或版本与协议发生变化，wrapper 会拒绝递归或不安全启动，并提示运行 `doctor` 或重新安装。不会改查 PATH 后的另一份 Codex。guarded interactive 每次都针对保存的同一绝对路径重新执行版本、帮助和 schema 探测；只有透明 remote 能力完整时才启动 TUI。

## wrapper 路由与明确旁路

- `codex`：启动受保护的原生交互 TUI。
- `codex --<原生交互参数>`：把兼容参数传给 TUI；`--remote` 和认证参数由 Guard 独占，用户不能覆盖。
- `codex-raw ...`、`codex raw ...`：直接执行保存的真实 Codex，并在交互式终端醒目提示本次不受额度保护。
- `CODEX_QUOTA_GUARD_BYPASS=1 codex ...`：只旁路当前调用，不写配置，也不清除 `HANDLED` 记录。
- `codex login|logout|mcp|app-server|completion|plugin|mcp-server|remote-control|update|doctor|features ...`：显示一行说明后透明执行原生管理命令，不启动额度控制会话。
- `codex exec ...`：首版明确拒绝，以免破坏原生命令的参数和退出码语义；改用 `codex-quota-guard run <提示>`，或明确选择无保护的 `codex-raw exec ...`。
- `codex --version`：显示 wrapper `0.3.0`、真实绝对路径、保存版本和实测版本；`codex-raw --version` 的 stdout 保持原始结果。
- 未知子命令：非 TTY 直接失败；TTY 显示解析结果，只有用户明确输入 `raw` 才旁路，空输入或其他内容均取消。未知文本不会被擅自当作任务提示。

当 `defaultInteractiveProtection=false` 时，无参数 `codex` 也会明确拒绝而不是静默 raw。配置只写 Guard 自己的全局文件：

```bash
codex-quota-guard config show
codex-quota-guard config show --json
codex-quota-guard config set default-require-protection true
codex-quota-guard config set default-require-protection false
```

`defaultRequireProtection=false` 是默认值：5 小时窗口暂时不可见时仍显示 `guard: DORMANT`、`turns: ALLOWED` 并允许 TUI。设为 true 后，只有唯一有效的 300 分钟窗口可用且已建立安全基线时才打开 TUI。

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

交互代理不会把用户 prompt、模型输出、工具调用正文或审批决定写入 Guard 状态和阈值报告。透明转发只发生在本次内存会话中；本地报告仍只包含额度事件、固定 turn 身份、已完成 item 摘要、错误和 Git 状态。Codex App、IDE 集成、`codex-raw`、独立 CLI 和其他进程不经过本工具，也不受该 Guard 控制。

本地报告只包含阈值事件、固定 turn、额度快照、已完成 item 摘要、错误和 Git 状态，不调用模型生成停止总结。报告把真实额度事件标为 `quotaThreshold`，把显式 canary 标为 `liveCanary`，并保存可用的 UTC 时间及由单调时钟计算的请求时延；缺少通知或对账证据时对应字段保持 `null`。

## 测试

```bash
npm run format:check
npm run typecheck
npm test
npm run build
```

所有自动化测试均使用 fake App Server transport 和 fake remote TUI。`npm test` 不启动真实 Codex，不访问真实账户，也不调用真实模型 `turn/start`。端到端测试虽然穿透真实 stdio、loopback WebSocket、代理和子进程清理，但发送的是空 fake turn，额度、审批和通知全部由本地脚本产生。

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
- 单轮 `run` 路径没有独立审批界面；需要审批的非交互 turn 会明确失败。`interactive` 使用原生 Codex TUI，App Server 的命令审批、文件审批和用户输入请求由透明代理双向转发给原生界面。
- 首版是单轮控制器，不是长任务编排器。每次 `run` 或带提示的 `resume` 最多启动一个 turn。
- 工具只能可靠控制由自身 App Server 会话创建或续接的 thread，不能安全附加到独立、不可控制的 Codex CLI 进程。
- 默认终端集成只影响安装标记块生效的当前 shell；Codex App、IDE、其他终端配置和已运行的独立进程不受控制。
- 原生 TUI 的 `--remote`、认证环境变量和 App Server 协议能力仍需针对当前 Codex 版本现场探测。任一安全透明代理能力缺失时，`interactive` 和 `shell install` 都拒绝接管默认 `codex`，并保留显式工具入口作为退化路径。
- 若协议同时返回多个可用于保护的 300 分钟窗口，工具按能力暂不可用处理并显示 `DORMANT`，不会任意选择 primary 或 secondary。
- `doctor` 在 App Server 和额度读取正常、但快照只有 weekly 等非 5 小时窗口时返回 `degraded` 而不是 `failed`；这表示当前无法提供 5 小时保护，不表示工具或额度读取失败。
