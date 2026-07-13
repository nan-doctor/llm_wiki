# Codex Quota Guard 实施计划

## 调查结论

- 目标仓库为 `llm_wiki/`，工具固定放在 `tools/codex-quota-guard/`。
- 本机为 `codex-cli 0.131.0`，`codex app-server`、`generate-ts`、`generate-json-schema` 均可用。
- 已在临时目录生成稳定版与实验版协议，并在不调用 `turn/start` 的前提下完成真实 `initialize`、`initialized` 和 `account/rateLimits/read` 探测。
- 当前协议中，额度读取和更新通知可用；Goal 支持 `active | paused | budgetLimited | complete`；Goal 操作和 `thread/backgroundTerminals/clean` 需要 `experimentalApi`。
- 采用隔离的 TypeScript/Node 单轮控制器，使用独立 `package.json`、锁文件、TypeScript 和 Vitest 配置，不修改或复用根构建配置。

## 架构

1. App Server 客户端负责启动与维护 `codex app-server --listen stdio://`、JSONL 请求关联、初始化握手、退出检测和指数退避重连。
2. 启动、重连及每次 `turn/start` 前调用 `account/rateLimits/read`；监听 `account/rateLimits/updated`，先合并通知，再合并触发一次完整读取。
3. 额度归一化优先读取 `rateLimitsByLimitId.codex`，不存在时回退到 `rateLimits`。`remaining = 100 - usedPercent`。使用 `windowDurationMins === 300` 识别唯一的 5 小时保护窗口，不依赖 primary/secondary 字段名；找不到可唯一识别且具有 resetsAt 的 300 分钟窗口时 guard 为 `DORMANT`、turn 保持 `ALLOWED`，明确显示 `5h protection unavailable`。credits 只显示，不参与保护。
4. 单轮控制器实现 `run` 和 `resume`，每次最多启动一个 turn；所有额度更新、阈值事件和 `turn/start` 经过同一互斥门。
5. 状态写入 `.codex-guard/state.json`，使用临时文件、同步和原子重命名；进程锁避免两个控制器同时运行。
6. 阈值报告完全由本地事件、Git 状态、已完成 item 和错误生成，不调用模型。

## 状态模型

额度计算职责严格分离：

- `protectedRemainingPercent` 只来自 300 分钟窗口，只由它决定 2% 一次性中断。
- `overallRemainingPercent` 是所有有效窗口中的最低剩余，只用于展示和诊断。
- weekly 或任何非 300 分钟窗口（无论位于 primary 还是 secondary）无论多低都不得触发中断；位于 secondary 的 300 分钟窗口仍是保护窗口。

保护额度严重度：

- `SAFE`：剩余大于 5%。
- `WARNING`：剩余大于 3% 且不高于 5%。
- `LOW`：剩余大于 2% 且不高于 3%。
- `CRITICAL`：剩余不高于 2%。
- `UNKNOWN`：数据缺失、无效或过期。

保护器状态：`ARMED | HANDLING | HANDLED | DORMANT | UNKNOWN`。`DORMANT` 表示当前快照没有可用 5 小时窗口，不是工具失败，不回退到 weekly，也不限制新 turn。不得使用全局 `STOPPED`，`WARNING` 和 `LOW` 只提示，不限制新 turn，不提供 `--small`，也不分析提示词规模。

当 5 小时保护窗口剩余第一次从高于 2% 变为不高于 2% 时：

1. 原子记录 `quotaThresholdEvent` 并快照当时的 active `threadId`、`turnId`。
2. 先把当前窗口写成 `thresholdHandled: true` 和 `HANDLING`，再执行副作用。
3. 只对快照中的 turn 调用 `turn/interrupt`；不得改为中断之后启动或恢复的 turn。
4. 清理该 thread 的后台 terminal，保存并暂停 Goal，但绝不清除 Goal。
5. 生成本地报告并更新为 `HANDLED`。
6. 没有 active turn 时直接标记 `HANDLED`，之后启动的任务不受该事件影响。

同一 5 小时窗口最多处理一次。`windowKey` 只由 limitId、300 和该 5 小时窗口的 resetsAt 构造。只有该窗口重置、该窗口 `resetsAt` 改变，或该窗口额度先恢复到高于 5% 后，才重新布防；weekly 的变化不得重新布防。`HANDLED + CRITICAL` 时仍显示 `turns: ALLOWED`，后续 `run`、`resume` 和新 turn 均允许继续。

5 小时窗口暂时消失时保留原 windowKey、thresholdHandled 和事件记录；相同 key 返回时恢复原 HANDLED，新 key 返回时自动 ARMED。数据真正过期时先重连并重读；仍未知才以数据可信度理由阻止新的 `turn/start`。`UNKNOWN` 或 `DORMANT` 都不得清除同一窗口已经持久化的 HANDLED 事实。

## 命令接口

- `status [--json]`：读取并显示两个窗口、used、left、窗口长度、重置时间、credits、quota severity、guard state 和 turns 准入状态。
- `run <提示> [--thread <id>] [--goal <目标>] [--token-budget <数量>] [--max-runtime <时长>] [--max-turns <数量>] [--json]`：创建或续接 thread，经过准入检查后启动一个 turn。
- `resume [提示] [--json]`：恢复最近一次中断的同一 thread 和原 Goal；不重新布防同一窗口。有提示时启动一个新 turn，无提示时仅恢复。没有可恢复记录时明确报错并提示使用 `run`。
- `doctor [--json]`：检查版本、生成实验 schema、核对所需方法并完成真实握手和额度读取；不得调用 `turn/start`。只有 weekly、没有 5 小时窗口时报告 `degraded` 和 `fiveHourProtectionAvailable: false`，而不是失败。

Goal tokenBudget、可选最大运行时间、可选最大 turn 数与账户额度保护分别记录和执行，禁止互相换算。

## 竞态与错误策略

- 阈值处理和 `turn/start` 串行化；`HANDLING` 期间新 turn 等待，完成后放行。
- 事件先持久化固定目标；崩溃恢复只能重试该固定 turn 的幂等中断。
- 重复 updated 和重复 interrupt 必须去重；“已结束”“不存在”“已中断”按幂等完成处理。
- App Server 退出后重新握手、重新读取额度并用保存的 thread/turn 对账。
- Goal 暂停失败时仍完成 turn 中断并记录降级；不得调用 `thread/goal/clear`。
- 状态和报告通过字段白名单与敏感键过滤，禁止保存 access token、cookie、授权头或认证响应。

## 文件与范围

新增计划文档、独立工具包、源码、fake transport、测试和 README；仅在根 `.gitignore` 加入 `/.codex-guard/`。不得修改现有业务源码、根 `package.json`、根锁文件或根 TypeScript/Vitest 配置。

## 测试与验收

所有自动测试使用 fake App Server，`npm test` 不启动真实 Codex。覆盖 5 小时窗口 98% used、weekly 98% 不触发、两者均 98% 只由 5 小时窗口触发、仅 weekly 时 guard DORMANT 且 turn ALLOWED、5 小时稍后出现自动 ARMED、HANDLED 窗口短暂消失并以同 key 返回不重复、出现新 key 重新布防、weekly reset 不重新布防、HANDLED 后放行、多 limitId、credits、不完整与重复 updated、重复 interrupt、阈值与新 turn 竞态、退出重连、过期数据、重启去重、resume、Goal 暂停恢复、进程锁、原子写入、文本和 JSON 输出及敏感信息排除。

完成前必须通过工具自己的格式检查、类型检查、构建和全部测试，并逐条审计：同一窗口一次事件、只中断固定原 turn、HANDLED 后允许继续、Goal 不清除、测试零真实模型调用、报告零模型调用、README 完整说明阈值语义和无法数学精确停在 2.000% 的限制。

## 交付后加固实施计划

本轮仅增加交付诊断、显式严格准入、打包和跨平台验证，不改写一次性边沿状态机。当前工作树位于含用户未提交改动的 `main`，因此不执行提交操作。

### 任务一：计划文件可提交性

- [x] 在根 `.gitignore` 中先重新允许 `docs/` 遍历，再继续忽略其中其他文件，只精确允许 `docs/codex-quota-guard-plan.md`。
- [x] 运行 `git check-ignore docs/codex-quota-guard-plan.md`，确认没有匹配输出且退出码为 1。
- [x] 运行 `git status --short --untracked-files=all`，确认计划文件以未跟踪文件出现。

### 任务二：weekly-only 与冷启动诊断

- [x] 先修改 `test/ui.test.ts`，要求 weekly-only 文本显示 `5h protection: UNAVAILABLE`，不显示 `quota: UNKNOWN`，JSON 包含 `protectedWindow.available=false` 和明确 reason。
- [x] 增加首次看到 5 小时窗口已经不高于 2% 时 `awaitingBaseline=true` 的输出测试。
- [x] 修改 `src/ui/status.ts`，从现有 guard/quota 状态派生 `protectedWindow` 诊断，不给持久化状态增加迁移字段。
- [x] 修改 `test/guard-state-machine.test.ts`，证明冷启动低额度不触发，恢复到高于 5% 后再次跨越 2% 才触发一次。

### 任务三：显式严格准入

- [x] 先修改 `test/cli-args.test.ts` 和 `test/controller.test.ts`，定义 `run --require-protection` 的解析与 DORMANT 拒绝行为，同时保留默认 `run` 放行。
- [x] 修改 `src/cli-args.ts`、`src/guard/controller.ts` 和 `src/cli-runtime.ts`，只在该次 `run` 显式传入严格准入选项时拒绝缺失 5 小时窗口。

### 任务四：帮助、协议能力矩阵与未知版本

- [x] 先增加 `--help` 解析和 CLI 输出测试，再实现不启动控制器的帮助命令。
- [x] 扩展 `test/doctor.test.ts`，要求当前版本、每项能力和兼容性依据可见；未知版本必须显示 schema 验证依据和降级警告。
- [x] 修改 `src/doctor.ts` 和 `src/cli-runtime.ts`，输出 `turn/start`、`turn/interrupt`、Goal paused、后台 terminal 清理等能力矩阵。

### 任务五：打包、CI 与真实 canary 手工方案

- [x] 修改独立 `package.json`，只打包 `dist/` 和 README，并用 `prepack` 保证构建产物完整。
- [x] 新增 `.github/workflows/codex-quota-guard.yml`，在 macOS、Linux、Windows 上运行安装、格式、类型、测试和构建，测试重点仍由 fake transport、进程锁和原子写入用例承担。
- [x] 在 README 中记录 `doctor --live-canary` 的显式人工步骤、额度消耗与确认要求；最终验收阶段增加双重确认的显式 canary，普通 doctor 仍保持零真实 turn。
- [x] 运行 `npm pack --dry-run`，创建 tgz，在临时 prefix 安装，并从仓库外执行 `--help`、`status` 和 `doctor`；只有后两项使用真实 App Server，绝不调用 `turn/start`。
- [x] 最后依次运行 `npm test`、`npm run typecheck`、`npm run format:check`、`npm run build`、`npm ls --depth=0` 和 `npm pack --dry-run`。

## 最终验收实施计划

> **执行方式：** 在当前工作树内使用测试先行逐项实施；不改写 5 小时额度一次性边沿状态机，不提交用户无关改动。

**目标：** 完成候选版的最终可信度验证，严格区分 schema 能力与运行时实测，继承严格保护策略，并执行一次双重确认的极小 live canary。

### 任务一：严格保护语义闭环

- [x] 在 `test/controller.test.ts` 先增加失败测试：`awaitingBaseline + requireProtection` 必须在 `thread/start` 前拒绝，默认 run 仍放行。
- [x] 增加严格 run 触发中断后，5 小时窗口暂时消失时 `resume` 继承严格策略并拒绝的测试。
- [x] 在 `PersistedGuardState.limits` 保存 `requireProtection`，加载旧状态时默认迁移为 false；`resume` 使用保存值准入。

### 任务二：能力矩阵分层

- [x] 在 `test/doctor.test.ts` 和 `test/cli-runtime.test.ts` 先要求每项能力同时输出 `schemaDetected` 与 `runtimeVerified`。
- [x] 普通 doctor 只把真实握手和 `account/rateLimits/read` 标成 runtime verified；turn、interrupt、Goal 与 terminal 在未执行 canary 时显示 NOT_TESTED。
- [x] 未知版本继续只以现场 schema 为依据并保持 degraded，不把 schema detected 写成 runtime verified。

### 任务三：受控 live canary

- [x] 先测试 `doctor --live-canary` 必须同时具有显式参数和 `CODEX_QUOTA_GUARD_LIVE_CANARY=I_ACCEPT_MODEL_USAGE`，普通 doctor 永不调用 `turn/start`。
- [x] 使用 fake App Server 测试唯一一次 `turn/start`；预先订阅 `turn/started`，通知到达时立即精确 `turn/interrupt`，随后验证 Goal get/pause/读取确认/恢复和后台 terminal 清理。
- [x] 实现独立 canary 执行器；失败时尽最大努力恢复原 Goal，不启动第二个 turn，并把每项 runtime 结果写入能力矩阵。
- [x] 在 macOS 上显式执行一次真实 canary，保存 threadId、turnId 和逐项结果，不输出认证信息；结果为部分通过，详见下方验收记录。

### 任务四：跨平台真实结果

- [x] 保持 macOS/Linux/Windows Actions 矩阵，检查 GitHub 登录和远端状态。
- [x] 获得外部写入授权与有效 GitHub 登录后，只提交本工具、计划、CI 和精确 `.gitignore` 变更，等待 Linux/Windows runner 实际结果。
- [x] 在外部条件未满足时保持 Goal 活跃并准确报告阻塞，不用本机测试冒充远端结果；条件满足后使用真实 runner 结果完成验收。

### 最终验收记录（2026-07-13，macOS）

- 普通 `doctor --json`：`codex-cli 0.131.0`、App Server 握手和额度读取正常；当前快照只有 weekly、没有 300 分钟窗口，因此按设计返回 `degraded`，并显示 five-hour protection unavailable。
- 能力矩阵已区分 schema 与运行时证据。普通 doctor 仅把 `account/rateLimits/read` 标为运行时已验证，其余未执行能力保持 `NOT_TESTED`。
- live canary 的首个实现暴露了响应后中断的竞态。依据官方 App Server 生命周期改为预先监听 `turn/started`，并新增“通知先于 `turn/start` 响应”测试；真实复验中 `turn/start`、精确 `turn/interrupt` 和后台 terminal 清理均通过运行时验证。
- 最终真实 canary 只启动一个 turn：`threadId=019f591e-cb55-7ad3-a77e-ebd47efb0771`，`turnId=019f591e-eb0f-7171-89c3-c451ff1ad9e6`。Goal 写入返回 `no such table: thread_goals`，因此 `goalSet` 为运行时失败，`goalGet` 和 `goalPaused` 未测试；没有启动补偿性第二个 turn。
- 后续完成度审计把 Goal set/get 移到 live canary 的模型调用前作为零额度预检。未来若同类 Goal 运行时错误仍存在，canary 会在 `turn/start` 前失败，不再重复消耗模型额度。
- 本机 `codex features list` 显示 goals 为 experimental 且默认关闭；工具通过公开的 `--enable goals` 启动 App Server。现场 SQLite 只读检查确认 `state_5.sqlite` 不含 `thread_goals` 表。该问题属于当前 Codex 安装的 Goal 运行时能力，不得通过工具私自修改用户 Codex 数据库规避。
- `myfork` 远端可读，但主分支目前只有既有 Build & Release 与 CI 两个 workflow，本工具 workflow 尚未提交；同时本机 `gh` 的 `nan-doctor` 凭据无效。因此 Linux、Windows runner 没有可声称的实际结果。
- 阶段性发布判断：当时仍保持 `0.1.0` 候选状态；后续 Goal 实机验证和三平台 Actions 已完成，最终结论见文末。

### 继续完成度审计补强

- 修复 `turn/completed` 早于 `turn/start` 响应时的等待竞态；完成状态由控制器缓存并交给随后注册的等待者，避免挂起或重复中断。
- 正确区分同时包含 `id` 和 `method` 的 App Server 双向服务器请求；首版对不支持的交互请求返回 JSON-RPC 错误并保存诊断，不再静默丢弃。
- `turn/completed.status=failed` 时保存服务端错误，CLI 不再以退出码 0 伪装成功。
- 按当前生成 schema 将额度快照内部字段视为可省略；空快照稳定归一化为 `UNKNOWN` 和显式 `null`。
- 扩展错误字符串脱敏，覆盖 Bearer、`access_token: ...`、`cookie=...` 等形式。
- 增加 Goal 数据库不可用的正常控制器测试，确认固定 turn 中断、后台 terminal 清理、`HANDLED` 和本地报告不依赖 Goal 成功。

### macOS 内置 Codex 复核

- PATH 当前指向 Hermes 全局 `@openai/codex@0.131.0`；ChatGPT 应用另带 `/Applications/ChatGPT.app/Contents/Resources/codex`，版本为 `0.144.0-alpha.4`，goals 显示为 stable 且默认开启。
- 使用应用内置二进制运行普通 doctor：schema、App Server 握手和额度读取通过；因版本尚未认证且当前只有 weekly 窗口，整体为 `degraded`。
- 在不调用 `turn/start` 的专用 thread 上，Goal `active → paused → active`、读取确认和后台 terminal 清理全部通过，证明旧 PATH 版本的 `thread_goals` 错误不是工具主路径错误。
- 随后的单 turn canary 完成 Goal 预检，但 5 秒内未收到 `turn/started`，因此未盲目中断并停止连接；结果为 failed，`turnId=null`。没有进行实机重试。
- 事后只读 `thread/read` 显示该 thread 实际产生一个 turn：`c5dd0b33-e880-4268-a553-6a2ec79e4636`，连接停止后状态为 `interrupted`。这证明失败点是通知/响应时序，而不是 Goal 或 turn 创建能力。
- 已用 6 秒延迟通知的假传输失败测试把硬编码 5 秒等待窗暴露出来，并将等待上限改为与 App Server 默认请求时限一致的 15 秒。该修复已自动验证，但尚未再次消耗真实额度做实机复验。
- 增加 `thread/read` 安全对账回退：通知超时后只在唯一确认一个 `inProgress` turn 时精确中断；零个或多个候选都明确失败。该路径已由 fake App Server 自动验证，未做实机重试。
- macOS 用户可通过 `PATH="/Applications/ChatGPT.app/Contents/Resources:$PATH"` 为单次命令选择应用内置 Codex，无需升级或覆盖全局 npm 安装。

### 用户授权后的最终 canary

- 使用 ChatGPT 应用内置 `codex-cli 0.144.0-alpha.4` 只执行一次修复后 canary，没有重试。
- `threadId=019f593c-f16a-70c3-960e-3b19223901e3`；`turn/start` 响应 ID 为 `019f593d-0225-79b2-96ac-8712502fd15c`，`thread/read` 唯一活动 turn ID 为 `447823b4-bad5-4680-b7ea-ebe43b132e61`。
- 工具按后者发出精确 `turn/interrupt`；只读回查确认该 turn 最终为 `interrupted`，无错误。Goal set/get/paused/恢复和后台 terminal 清理均通过。
- 当时版本仍把响应 ID 与运行时 ID 不同判为 canary failed；现场证据证明实际控制动作成功。随后增加失败测试并修复：正常控制器和 canary 均以通知或唯一 `inProgress` ID 为权威，不再要求两种 ID 相同。
- 该兼容修复已由 fake App Server 聚焦测试验证。遵守“一次且不重试”约束，没有再启动真实 turn。

### GitHub Actions 与最终发布结论

- 用户授权后重新登录 `nan-doctor`，确认 fork 具有 push 和 workflow 权限。由于 fork `main` 与本地历史分叉，未强推；从最新 `myfork/main` 创建 `codex-quota-guard` 分支并只拣选授权范围提交。
- 首轮 Actions：macOS、Linux 通过；Windows 的格式脚本把 CRLF 行尾 `\r` 误判为空白。修复脚本后保留对真实空格和制表符的检查。
- 第二轮 Actions [运行 #29219450924](https://github.com/nan-doctor/llm_wiki/actions/runs/29219450924) 全部通过：Windows、macOS、Linux 均完成 `npm ci`、格式、类型、86 项测试、构建和 `npm pack --dry-run`。
- 远端分支：`nan-doctor/llm_wiki:codex-quota-guard`。无关业务改动从未暂存或提交。
- 最终发布判断：`0.1.0` 从候选状态提升为首个正式可用基线。当前 PATH 中的旧 `codex-cli 0.131.0` 仍会把 Goal 降级，但主保护路径、错误报告和 resume 不依赖 Goal 成功；macOS 可按 README 显式选择 ChatGPT 应用内置 Codex 获得完整 Goal 能力。

## 0.2.0 增量发布设计

> **设计状态：** 已由用户批准。后续实施必须使用测试先行方式，不得重写现有 300 分钟窗口一次性边沿状态机、精确 turn 中断逻辑或 App Server 重连控制器。

### 设计目标与边界

本轮在 `0.1.0` 的外围增加可执行文件解析、共享运行上下文、能力分级、版本漂移检测、Goal 降级和时延审计。核心额度语义保持不变：只有 `windowDurationMins === 300` 的窗口可以触发中断；weekly 和其他窗口永远只显示；同一 windowKey 最多处理一次；`HANDLED` 后新任务继续允许；5 小时窗口缺失时保持 `DORMANT + ALLOWED`；不增加全局停止 latch，不调用 Goal clear。

### 方案选择

采用独立 resolver 与共享 `RuntimeContext`，不把平台探测和 schema 逻辑塞进额度状态机，也不让其他命令依赖 doctor 的过期缓存。每次 CLI 调用先构建一次运行上下文，`status`、`doctor`、`run`、`resume` 和该次 App Server 的全部重连都使用其中已经解析的同一个绝对可执行文件。

运行上下文至少包含：

- `codexExecutable`：按来源解析后的绝对路径；
- `codexExecutableRealPath`：解析符号链接后的真实绝对路径；
- `codexVersion`：同一文件执行 `--version` 的结果；
- `executableSelectionSource`：`cli | environment | config | path | discoveredCandidate`；
- `launchAllowed`：该解析结果是否经过用户配置链选择、可以用于启动或协议探测；
- `discoveredCandidates`：平台探测到、但没有自动选用的候选路径；
- `protocolFingerprint`：当前生成协议 schema 的稳定 SHA-256；
- `capabilities`：当前 schema 与运行时证据组成的能力矩阵；
- `appServerHandshake` 和 `rateLimitsRead` 的实际结果。

`discoveredCandidate` 是候选诊断来源，不是可启动选择：PATH 中没有 Codex 时，doctor 可以把候选绝对路径放入 `codexExecutable`，同时输出 `executableSelectionSource: discoveredCandidate` 和 `launchAllowed: false`。候选状态不执行 `--version`、schema 生成或 App Server 启动，必须提示用户通过 `--codex-path`、环境变量或项目配置明确选择。任何已选来源验证失败后都立即报错，不得自动跳到低优先级来源或候选。

### 可执行文件解析与项目配置

解析优先级固定为：

1. 当前命令的 `--codex-path <path>`；
2. 当前进程的 `CODEX_QUOTA_GUARD_CODEX_PATH`；
3. 当前项目 `.codex-guard/config.json` 中的 `codexPath`；
4. 当前 PATH 中的 `codex`。

CLI 参数和环境变量只影响当前进程，不回写配置。项目配置仅影响所在仓库。路径可以包含空格；相对路径以当前项目根目录解析为绝对路径。resolver 验证路径存在、指向普通文件、在当前平台可执行，并分别运行 `--version` 与 `app-server --help`。Windows 使用 PATH/PATHEXT 语义解析命令，但解析结果仍保存为绝对文件路径；macOS 和 Linux 校验可执行权限。平台候选发现使用可扩展的候选提供器，ChatGPT 应用路径只是 macOS 提供器的一项，不是跨平台唯一实现。

解析错误必须包含实际来源和候选路径、失败阶段、对额度读取、精确中断和 Goal 控制的影响，以及使用 `--codex-path` 修正的方法。错误和诊断继续经过敏感信息脱敏。

### 协议指纹与能力分级

运行上下文使用已选 Codex 生成实验 JSON schema，并对稳定选择的聚合 schema 内容计算 SHA-256。版本字符串用于诊断，协议指纹用于判断协议是否变化；两者都保存，不能互相替代。

每项能力保留兼容字段 `schemaDetected` 和 `runtimeVerified`，并新增单值状态：

- `unavailable`：schema 不存在或可执行文件无法提供该能力；
- `schemaDetected`：schema 已确认，但没有安全的运行时成功证据；
- `runtimeVerified`：当前相同真实路径、版本和协议指纹下实际调用成功；
- `degraded`：可选能力在 schema 中存在，但运行时不可用或失败，核心保护仍可工作；
- `failed`：已尝试的核心能力运行时失败，或严格模式要求的能力不可用。

能力矩阵覆盖 `account/rateLimits/read`、`account/rateLimits/updated`、`turn/start`、`turn/interrupt`、`thread/read`、`thread/goal/get`、Goal paused 设置、Goal resume、`thread/backgroundTerminals/clean` 和双向 JSON-RPC server request 处理。普通 doctor 不调用 `turn/start`，因此只把真实成功的握手和额度读取标为运行时已验证；其余能力最多为 schema detected。只有原有双重确认的 live canary 可以产生真实 turn 并写入 turn/interrupt 等运行时证据。

`--require-protection` 要求当前 300 分钟保护窗口可用、已经建立安全基线、App Server 握手和额度读取成功，并且 schema 包含额度更新、`turn/start`、`turn/interrupt` 和 `thread/read`。它不要求 Goal 能力，也不强迫用户执行真实 canary。新增 `--require-goal-control`；只有用户显式选择时，Goal pause/resume 不可用才拒绝启动或恢复。

### 持久化与版本漂移

状态文件以向后兼容方式增加运行上下文快照，不改变既有 guard、windowKey、HANDLED 或 resumable event 的含义。旧状态缺少新字段时迁移为“运行上下文未知”，下一次命令重新探测；不得据此清除已经处理的窗口记录。

创建或恢复任务时保存实际路径、真实路径、版本、协议指纹和能力矩阵。`resume` 比较保存值与当前值；任一路径、版本或指纹变化都必须：

1. 显示逐项变化；
2. 丢弃旧上下文中所有 `runtimeVerified` 继承；
3. 对新二进制重新执行不消耗模型的 resolver、schema、握手和额度读取探测；
4. 核心保护 schema、握手或额度读取下降时拒绝恢复；
5. Goal 单独报告 degraded，只有 `--require-goal-control` 时拒绝；
6. 将新探测结果保存后再允许新的 `turn/start`。

App Server 进程退出和重连仍由现有管理器处理，但连接工厂必须捕获同一个 `RuntimeContext.executable.codexExecutableRealPath`，不得重新读取 PATH 或再次选择其他二进制。

### Goal 降级与错误分类

阈值处理继续先对事件快照保存的原 `threadId` 和 `turnId` 发出精确 `turn/interrupt`，之后才尝试 Goal 和后台 terminal。Goal 数据库或 API 不可用时：

- 精确中断继续完成；
- `goalControl` 标为 `degraded`，`goalPaused` 保持 `false`；
- 不伪造暂停成功，不调用 Goal clear；
- 停止报告保存可诊断类别，例如 `goal_database_unavailable`、`goal_schema_unavailable` 或 `goal_runtime_failed`；
- 普通模式继续允许，严格 Goal 模式拒绝后续启动或恢复。

### 时延与审计数据

阈值事件和 live canary 结果增加以下可空 UTC 时间：`quotaSnapshotObservedAt`、`thresholdDetectedAt`、`activeTurnResolvedAt`、`interruptRequestedAt`、`interruptAcknowledgedAt`、`turnTerminalStateObservedAt`、`goalPauseRequestedAt`、`goalPauseAcknowledgedAt`、`backgroundTerminalCleanedAt`。

运行中使用注入的单调时钟记录同一进程内时间点，计算 `snapshotToDetectionMs`、`detectionToInterruptRequestMs`、`interruptRequestToAcknowledgementMs`、`interruptRequestToTerminalStateMs`。UTC 时间用于跨进程审计，不能反推单调时延；进程重启或通知缺失导致无法可靠计算时保持 `null`。`turnTerminalStateObservedAt` 只有收到终态通知或通过 `thread/read` 精确对账后才能写入，不能用 interrupt 响应时间冒充。

报告增加 `eventKind: quotaThreshold | liveCanary`，明确区分真实额度事件和模拟 canary。所有新状态、错误、JSON、Markdown 与命令输出继续应用 token、cookie、authorization、secret 等敏感字段过滤。

### 状态与 doctor 输出兼容

`status --json` 保留既有字段和 `schemaVersion` 语义，只追加 `executable`、`protocolFingerprint`、`capabilities`、`goalControl` 与 `runtimeChanges`。文本状态先显示实际 Codex 路径、版本和选择来源，再显示额度、guard 和 turns；不得用 Goal 降级覆盖额度保护状态。

doctor 文本和 JSON 明确输出实际路径、真实路径、版本、选择来源、候选提示、协议指纹、握手、额度读取和逐项能力状态。普通 doctor 的零模型额度边界保持不变；`--live-canary` 仍需要命令参数与环境变量双重确认，并且不会自动重试。

### 测试与发布边界

自动测试全部使用 fake 可执行文件探测、fake App Server 和注入时钟，不调用真实模型。新增测试覆盖解析优先级、带空格路径、缺失或不可执行文件、版本与 app-server 探测失败、不静默回退、Goal 数据库降级、严格 Goal 模式、resume 路径/版本/指纹变化、重新探测、能力分级、时延计算、thread/read 对账、脱敏和三平台差异。现有 86 项测试尤其是 300 分钟窗口一次性边沿、weekly 永不触发、DORMANT + ALLOWED、HANDLED 后放行和固定 turn 中断测试必须原样保持通过。

发布版本采用 `0.2.0`。只修改 `tools/codex-quota-guard/**`、`docs/codex-quota-guard-plan.md` 和专属 `.github/workflows/codex-quota-guard.yml`；不修改业务源码、根 TypeScript/Vitest 配置、根 package 文件或用户未提交改动。发布文档增加 CHANGELOG、发布检查清单、安装卸载和 tarball 临时安装验证，并明确真实 macOS canary 与 Linux/Windows fake transport CI 的验证边界。本轮不重复真实 live canary，除非用户再次明确授权。

# Codex Quota Guard 0.2.0 增量发布实施计划

> **执行者要求：** 必须逐任务使用 `test-driven-development`；在当前会话内执行时使用 `executing-plans`，若用户明确要求子代理才可使用 `subagent-driven-development`。所有步骤使用复选框跟踪。

**目标：** 在不改变 300 分钟窗口一次性边沿保护的前提下，为 Codex Quota Guard 增加可预测的 Codex 可执行文件解析、共享运行上下文、能力分级、版本漂移保护、Goal 安全降级、时延审计和 `0.2.0` 发布资料。

**架构：** CLI 先通过单一 resolver 选择并验证绝对 Codex 路径，再生成 schema、计算协议指纹并构造 `RuntimeContext`。四个命令和全部 App Server 重连都注入同一上下文；控制器只消费上下文和能力，不参与路径选择。状态文件追加任务运行上下文和审计信息，既有 guard/windowKey/HANDLED 转移保持不变。

**技术栈：** Node.js 20、TypeScript、Vitest、Codex App Server JSON-RPC、Node `child_process`/`fs`/`crypto`、GitHub Actions。

---

## 文件职责图

新增文件：

- `tools/codex-quota-guard/src/runtime/types.ts`：可执行文件、协议身份、能力和运行上下文公共类型。
- `tools/codex-quota-guard/src/runtime/executable-resolver.ts`：优先级选择、PATH/PATHEXT 解析、候选发现和二进制验证。
- `tools/codex-quota-guard/src/runtime/capabilities.ts`：schema 检查、指纹计算和能力证据分级。
- `tools/codex-quota-guard/src/runtime/runtime-context.ts`：把 resolver 与 schema 探测组合为单次 CLI 运行上下文。
- `tools/codex-quota-guard/src/persistence/config-store.ts`：读取当前项目 `.codex-guard/config.json`。
- `tools/codex-quota-guard/src/audit/timing.ts`：UTC 审计时间、单调时钟点和可空延迟计算。
- `tools/codex-quota-guard/test/executable-resolver.test.ts`：解析优先级、失败、不回退、空格和跨平台测试。
- `tools/codex-quota-guard/test/runtime-context.test.ts`：schema 指纹、上下文构造和命令共享测试。
- `tools/codex-quota-guard/test/capabilities.test.ts`：五级能力证据测试。
- `tools/codex-quota-guard/test/audit-timing.test.ts`：真实事件与 canary 延迟计算测试。
- `tools/codex-quota-guard/CHANGELOG.md`：`0.2.0` 变更与兼容边界。
- `tools/codex-quota-guard/RELEASE_CHECKLIST.md`：可重复的发布验收清单。

增量修改文件：

- `src/cli-args.ts`、`src/cli-runtime.ts`、`src/cli.ts`：四个命令共享 `--codex-path` 和 `RuntimeContext`，增加严格 Goal 参数。
- `src/doctor.ts`：消费上下文、输出完整能力矩阵并记录 canary 时延。
- `src/app-server/process-connection.ts`：强制使用已解析真实路径，不保留隐式 `codex` 回退。
- `src/app-server/manager.ts`：暴露握手/额度运行证据，不改变重连算法。
- `src/guard/state-machine.ts`：只追加事件审计和运行上下文字段，不改转移条件。
- `src/guard/controller.ts`：持久化任务运行上下文、处理漂移、Goal 降级和审计时间。
- `src/persistence/state-store.ts`：为旧状态补齐新可选字段并继续脱敏。
- `src/report/local-reporter.ts`、`src/ui/status.ts`：追加上下文、能力、错误类别和延迟输出。
- 现有测试：补回归断言，证明核心边沿、精确 turn 和零真实模型边界未改变。
- `package.json`、`package-lock.json`、`README.md`、专属 workflow：版本、发布文档和三平台验证。

## 任务一：CLI 参数与项目配置

**文件：**

- 新建：`tools/codex-quota-guard/src/persistence/config-store.ts`
- 新建：`tools/codex-quota-guard/test/config-store.test.ts`
- 修改：`tools/codex-quota-guard/src/cli-args.ts`
- 修改：`tools/codex-quota-guard/test/cli-args.test.ts`

- [ ] **步骤 1：先写 CLI 失败测试**

在 `test/cli-args.test.ts` 为 `status`、`doctor`、`run`、`resume` 增加 `--codex-path "/路径 含空格/codex"` 断言，并为 `run/resume --require-goal-control` 增加断言：

```ts
expect(parseCliArgs(["status", "--codex-path", "/路径 含空格/codex"])).toMatchObject({
  command: "status",
  codexPath: "/路径 含空格/codex",
})
expect(parseCliArgs(["run", "执行", "--require-goal-control"])).toMatchObject({
  requireGoalControl: true,
})
expect(parseCliArgs(["resume", "继续", "--require-goal-control"])).toMatchObject({
  requireGoalControl: true,
})
```

- [ ] **步骤 2：运行测试并确认因字段缺失而失败**

运行：`npm test -- test/cli-args.test.ts`

预期：断言失败，实际结果没有 `codexPath` 或 `requireGoalControl`，不是语法错误。

- [ ] **步骤 3：实现命令参数的最小扩展**

所有非 help 命令都返回 `codexPath: string | undefined`；`run/resume` 返回 `requireGoalControl: boolean`。把 `codex-path` 加入各命令允许的值参数，把 `require-goal-control` 加入布尔参数集合：

```ts
const booleanFlags = new Set([
  "json",
  "require-protection",
  "require-goal-control",
  "live-canary",
])
```

- [ ] **步骤 4：先写配置读取失败测试**

新建 `test/config-store.test.ts`，在临时项目写 `.codex-guard/config.json` 并验证只接受非空字符串：

```ts
await writeFile(path.join(root, ".codex-guard", "config.json"), JSON.stringify({
  codexPath: "./bin/codex",
}))
expect(await new ConfigStore(root).load()).toEqual({ codexPath: "./bin/codex" })
await expect(loadConfigWith({ codexPath: 7 })).rejects.toThrow("codexPath 必须是非空字符串")
```

- [ ] **步骤 5：运行配置测试并确认模块不存在**

运行：`npm test -- test/config-store.test.ts`

预期：失败原因为无法导入 `ConfigStore`。

- [ ] **步骤 6：实现只读项目配置**

实现以下公开接口；文件不存在返回 `null`，JSON 损坏或字段无效明确报错，不写回文件：

```ts
import { readFile } from "node:fs/promises"
import path from "node:path"

export interface GuardConfig { codexPath?: string }

export class ConfigStore {
  constructor(private readonly rootDirectory: string) {}
  async load(): Promise<GuardConfig | null> {
    const file = path.join(this.rootDirectory, ".codex-guard", "config.json")
    let raw: string
    try {
      raw = await readFile(file, "utf8")
    } catch (error) {
      if (error instanceof Error
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Codex Quota Guard 配置必须是 JSON 对象")
    }
    const codexPath = (value as { codexPath?: unknown }).codexPath
    if (codexPath !== undefined
      && (typeof codexPath !== "string" || codexPath.trim() === "")) {
      throw new Error("codexPath 必须是非空字符串")
    }
    return codexPath === undefined ? {} : { codexPath }
  }
}
```

- [ ] **步骤 7：运行聚焦测试并提交**

运行：`npm test -- test/cli-args.test.ts test/config-store.test.ts`

预期：两个测试文件全部通过。

提交：

```bash
git add tools/codex-quota-guard/src/cli-args.ts tools/codex-quota-guard/src/persistence/config-store.ts tools/codex-quota-guard/test/cli-args.test.ts tools/codex-quota-guard/test/config-store.test.ts
git commit -m "feat: 增加 Codex 路径参数和项目配置"
```

## 任务二：可执行文件 resolver

**文件：**

- 新建：`tools/codex-quota-guard/src/runtime/types.ts`
- 新建：`tools/codex-quota-guard/src/runtime/executable-resolver.ts`
- 新建：`tools/codex-quota-guard/test/executable-resolver.test.ts`

- [ ] **步骤 1：写优先级和空格路径失败测试**

使用注入依赖，避免测试启动真实 Codex：

```ts
const result = await resolveCodexExecutable({
  rootDirectory: "/repo",
  cliPath: "/cli path/codex",
  environmentPath: "/env/codex",
  configPath: "/config/codex",
}, fakeResolver({ pathCodex: "/path/codex" }))
expect(result).toMatchObject({
  codexExecutable: "/cli path/codex",
  executableSelectionSource: "cli",
  launchAllowed: true,
})
```

分别删除高优先级输入，断言 environment、config、path 依次获选。

- [ ] **步骤 2：运行优先级测试并确认 resolver 不存在**

运行：`npm test -- test/executable-resolver.test.ts`

预期：失败原因为模块或导出不存在。

- [ ] **步骤 3：定义解析结果和验证错误类型**

在 `runtime/types.ts` 定义：

```ts
export type ExecutableSelectionSource =
  | "cli" | "environment" | "config" | "path" | "discoveredCandidate"

export interface ResolvedCodexExecutable {
  codexExecutable: string
  codexExecutableRealPath: string | null
  codexVersion: string | null
  executableSelectionSource: ExecutableSelectionSource
  launchAllowed: boolean
  discoveredCandidates: string[]
}

export class CodexExecutableError extends Error {
  constructor(
    message: string,
    readonly executable: string | null,
    readonly source: ExecutableSelectionSource | null,
    readonly stage: "selection" | "stat" | "executable" | "version" | "app-server-help",
  ) { super(message) }
}
```

- [ ] **步骤 4：实现只选择一次的优先级骨架**

`resolveCodexExecutable` 先选择第一个已配置来源，再只验证这个来源。相对 CLI、环境和配置路径使用 `path.resolve(rootDirectory, value)`；PATH 解析结果已经是绝对路径。验证调用使用 `execFile` 而不是 shell，以支持空格。

```ts
export async function resolveCodexExecutable(
  input: ResolveCodexInput,
  dependencies: ResolverDependencies = defaultResolverDependencies(),
): Promise<ResolvedCodexExecutable>
```

- [ ] **步骤 5：写失败不回退和验证阶段测试**

增加不存在、非普通文件、Unix 不可执行、`--version` 非零、`app-server --help` 非零测试。每个测试同时提供一个有效低优先级 PATH Codex，并断言低优先级文件从未执行：

```ts
await expect(resolveCodexExecutable({
  rootDirectory: "/repo",
  cliPath: "/broken/codex",
}, fake)).rejects.toMatchObject({ stage: "version", source: "cli" })
expect(fake.executedPaths).toEqual(["/broken/codex"])
```

- [ ] **步骤 6：运行测试并确认各失败分支尚未满足**

运行：`npm test -- test/executable-resolver.test.ts`

预期：新增失败用例分别显示缺少对应验证或发生了错误回退。

- [ ] **步骤 7：实现文件、权限、版本和 app-server 验证**

Unix/macOS 使用 `fs.access(path, constants.X_OK)`；Windows 校验普通文件并通过 PATHEXT/PATH 解析。验证命令固定为：

```ts
await dependencies.run(executable, ["--version"])
await dependencies.run(executable, ["app-server", "--help"])
```

两次都成功后才返回真实路径和版本；任一步失败抛出含影响说明和 `--codex-path` 修正建议的 `CodexExecutableError`。

- [ ] **步骤 8：写三平台与候选提示测试**

注入 `platform: "darwin" | "linux" | "win32"`、PATH 和 PATHEXT，验证相同行为。PATH 完全缺失而 macOS 候选存在时断言：

```ts
expect(result).toMatchObject({
  codexExecutable: "/Applications/ChatGPT.app/Contents/Resources/codex",
  executableSelectionSource: "discoveredCandidate",
  launchAllowed: false,
  codexVersion: null,
})
expect(fake.executedPaths).toEqual([])
```

- [ ] **步骤 9：运行 resolver 测试、类型检查并提交**

运行：`npm test -- test/executable-resolver.test.ts`

运行：`npm run typecheck`

预期：全部通过。

提交：

```bash
git add tools/codex-quota-guard/src/runtime tools/codex-quota-guard/test/executable-resolver.test.ts
git commit -m "feat: 增加不可静默切换的 Codex resolver"
```

## 任务三：协议指纹与五级能力证据

**文件：**

- 新建：`tools/codex-quota-guard/src/runtime/capabilities.ts`
- 新建：`tools/codex-quota-guard/test/capabilities.test.ts`
- 修改：`tools/codex-quota-guard/src/doctor.ts`
- 修改：`tools/codex-quota-guard/test/doctor.test.ts`

- [ ] **步骤 1：写 schema 和指纹失败测试**

把现有 `inspectGeneratedProtocol` 用例迁移到新测试，并增加 `thread/read`、Goal resume 和 server request 检查。对相同文件集合的不同目录遍历顺序断言相同 SHA-256；内容变化断言指纹变化。

```ts
expect(await inspectGeneratedProtocol(root)).toMatchObject({
  rateLimitsRead: true,
  rateLimitsUpdated: true,
  turnStart: true,
  turnInterrupt: true,
  threadRead: true,
  goalGet: true,
  goalSet: true,
  goalPaused: true,
  goalResume: true,
  backgroundTerminalsClean: true,
  serverRequestHandling: true,
})
expect(await fingerprintProtocol(rootA)).toBe(await fingerprintProtocol(rootB))
```

- [ ] **步骤 2：运行测试并确认新能力字段和指纹缺失**

运行：`npm test -- test/capabilities.test.ts`

预期：失败原因为新模块或字段不存在。

- [ ] **步骤 3：实现稳定指纹与 schema 检查**

优先读取 `codex_app_server_protocol.v2.schemas.json`；缺失时按相对路径排序并连接全部 JSON 文件。使用 `createHash("sha256")`，绝不把临时目录绝对路径写入摘要。

- [ ] **步骤 4：写能力状态失败测试**

定义五级状态并验证 schema 与 runtime 不混淆：

```ts
expect(buildCapabilityEvidence(false, undefined)).toEqual({
  schemaDetected: false,
  runtimeVerified: null,
  status: "unavailable",
  detail: null,
})
expect(buildCapabilityEvidence(true, undefined).status).toBe("schemaDetected")
expect(buildCapabilityEvidence(true, true).status).toBe("runtimeVerified")
expect(buildCapabilityEvidence(true, false, { optional: true }).status).toBe("degraded")
expect(buildCapabilityEvidence(true, false, { optional: false }).status).toBe("failed")
```

- [ ] **步骤 5：运行测试并确认旧矩阵缺少 status**

运行：`npm test -- test/capabilities.test.ts test/doctor.test.ts`

预期：断言失败，旧证据只有两个字段。

- [ ] **步骤 6：实现兼容能力矩阵**

保留现有 `schemaDetected`、`runtimeVerified`，追加 `status`、`detail`。保留旧键并新增 `threadRead`、`goalResume`、`serverRequestHandling`：

```ts
export interface CapabilityEvidence {
  schemaDetected: boolean
  runtimeVerified: boolean | null
  status: "unavailable" | "schemaDetected" | "runtimeVerified" | "degraded" | "failed"
  detail: string | null
}
```

- [ ] **步骤 7：运行能力与 doctor 测试并提交**

运行：`npm test -- test/capabilities.test.ts test/doctor.test.ts`

运行：`npm run typecheck`

预期：全部通过，普通 doctor 的 turn/interrupt 仍不是 runtime verified。

提交：

```bash
git add tools/codex-quota-guard/src/runtime/capabilities.ts tools/codex-quota-guard/src/doctor.ts tools/codex-quota-guard/test/capabilities.test.ts tools/codex-quota-guard/test/doctor.test.ts
git commit -m "feat: 增加协议指纹和五级能力证据"
```

## 任务四：共享 RuntimeContext 与固定 App Server 路径

**文件：**

- 新建：`tools/codex-quota-guard/src/runtime/runtime-context.ts`
- 新建：`tools/codex-quota-guard/test/runtime-context.test.ts`
- 修改：`tools/codex-quota-guard/src/runtime/types.ts`
- 修改：`tools/codex-quota-guard/src/cli.ts`
- 修改：`tools/codex-quota-guard/src/cli-runtime.ts`
- 修改：`tools/codex-quota-guard/src/app-server/process-connection.ts`
- 修改：`tools/codex-quota-guard/test/cli-runtime.test.ts`
- 修改：`tools/codex-quota-guard/test/process-connection.test.ts`

- [ ] **步骤 1：写上下文构造失败测试**

```ts
const context = await createRuntimeContext({
  rootDirectory: "/repo",
  cliPath: "/chosen/codex",
}, fakeRuntimeDependencies())
expect(context).toMatchObject({
  executable: {
    codexExecutableRealPath: "/real/chosen/codex",
    executableSelectionSource: "cli",
  },
  protocolFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
})
```

候选 `launchAllowed: false` 时应返回诊断上下文但不得生成 schema。

- [ ] **步骤 2：运行测试并确认模块不存在**

运行：`npm test -- test/runtime-context.test.ts`

预期：失败原因为 `createRuntimeContext` 不存在。

- [ ] **步骤 3：实现运行上下文组合器**

```ts
export interface RuntimeContext {
  executable: ResolvedCodexExecutable
  protocolFingerprint: string | null
  schemaCapabilities: ProtocolCapabilities
  capabilityMatrix: CapabilityMatrix
}
```

用系统临时目录生成 schema，读取完成后在 `finally` 删除临时目录；候选诊断上下文不执行任何候选二进制。

- [ ] **步骤 4：写四命令共享 resolver 失败测试**

修改 `CliDependencies`，注入一次 `resolveRuntimeContext(codexPath)`，并让 `createController(context)`、`runDoctor(context, liveCanary)` 接收同一对象。测试 `status/doctor/run/resume` 传入 `--codex-path` 时 resolver 各调用一次。

- [ ] **步骤 5：运行 CLI 测试并确认旧依赖接口失败**

运行：`npm test -- test/cli-runtime.test.ts`

预期：类型或调用断言失败，证明四命令尚未共享上下文。

- [ ] **步骤 6：改造 CLI 依赖流**

`--help` 继续零探测。其他命令先构造上下文；`doctor` 不取得进程锁，其他命令取得锁后使用该上下文创建控制器。解析错误由统一格式器输出可执行路径和三类影响。

- [ ] **步骤 7：写并实现“无隐式 codex 回退”测试**

`ProcessConnectionOptions.codexPath` 改为必填。测试缺少路径无法构造或编译；启动和重连均断言 spawn 的第一个参数始终为上下文真实路径：

```ts
new ProcessAppServerConnection({
  codexPath: context.executable.codexExecutableRealPath!,
  enableGoals: true,
})
```

- [ ] **步骤 8：运行聚焦测试和完整基线并提交**

运行：`npm test -- test/runtime-context.test.ts test/cli-runtime.test.ts test/process-connection.test.ts test/app-server-manager.test.ts`

运行：`npm test`

预期：现有 86 项和新增测试全部通过。

提交：

```bash
git add tools/codex-quota-guard/src/runtime tools/codex-quota-guard/src/cli.ts tools/codex-quota-guard/src/cli-runtime.ts tools/codex-quota-guard/src/app-server/process-connection.ts tools/codex-quota-guard/test/runtime-context.test.ts tools/codex-quota-guard/test/cli-runtime.test.ts tools/codex-quota-guard/test/process-connection.test.ts
git commit -m "feat: 让所有命令共享 RuntimeContext"
```

## 任务五：持久化任务运行上下文与 resume 漂移检测

**文件：**

- 修改：`tools/codex-quota-guard/src/guard/state-machine.ts`
- 修改：`tools/codex-quota-guard/src/guard/controller.ts`
- 修改：`tools/codex-quota-guard/src/persistence/state-store.ts`
- 修改：`tools/codex-quota-guard/test/persistence.test.ts`
- 修改：`tools/codex-quota-guard/test/controller.test.ts`

- [ ] **步骤 1：写旧状态迁移和新状态持久化失败测试**

为 `PersistedGuardState` 追加但不改变 `schemaVersion: 1`：

```ts
runtime: {
  task: RuntimeIdentity | null
  current: RuntimeIdentity | null
  capabilities: CapabilityMatrix | null
  changes: RuntimeChange[]
}
```

删除旧状态 JSON 中的 `runtime` 后加载，断言默认值存在且 guard/HANDLED/windowKey 保持原值。

- [ ] **步骤 2：运行持久化测试并确认缺少 runtime**

运行：`npm test -- test/persistence.test.ts`

预期：失败为加载结果没有 runtime，不允许出现 schemaVersion 不兼容错误。

- [ ] **步骤 3：实现向后兼容默认值**

`createInitialState` 设置空 runtime；`StateStore.load` 用空值补齐新字段，不改 `schemaVersion`，不清除事件或 HANDLED。

- [ ] **步骤 4：写路径、版本、指纹漂移失败测试**

在 `controller.test.ts` 分别改变 `codexExecutableRealPath`、`codexVersion`、`protocolFingerprint`。断言 `resume`：

```ts
expect(repository.state?.runtime.changes).toContainEqual({
  field: "protocolFingerprint",
  previous: "old",
  current: "new",
})
expect(repository.state?.runtime.capabilities?.turnInterrupt.runtimeVerified).toBeNull()
```

核心 schema 缺失时在 `turn/start` 前拒绝；Goal 能力单独下降时普通模式继续。

- [ ] **步骤 5：运行控制器测试并确认旧结果被静默沿用**

运行：`npm test -- test/controller.test.ts`

预期：漂移测试失败，证明尚未比较身份或清除旧 runtime 证据。

- [ ] **步骤 6：实现运行身份比较和任务快照**

新增纯函数：

```ts
export function compareRuntimeIdentity(
  previous: RuntimeIdentity | null,
  current: RuntimeIdentity,
): RuntimeChange[]

export function invalidateRuntimeEvidence(
  matrix: CapabilityMatrix,
  changed: boolean,
): CapabilityMatrix
```

新 `run` 在成功启动任务前保存 `task=current`；`resume` 先比较、重新使用当前安全探测结果、检查核心能力，再把 `task` 更新为当前身份。任何漂移都不得继承旧的 `runtimeVerified`。

- [ ] **步骤 7：运行持久化、控制器和核心状态机测试并提交**

运行：`npm test -- test/persistence.test.ts test/controller.test.ts test/guard-state-machine.test.ts`

预期：全部通过，原状态机测试无修改或只增加字段断言。

提交：

```bash
git add tools/codex-quota-guard/src/guard tools/codex-quota-guard/src/persistence/state-store.ts tools/codex-quota-guard/test/persistence.test.ts tools/codex-quota-guard/test/controller.test.ts
git commit -m "feat: 在恢复任务时检测 Codex 运行环境漂移"
```

## 任务六：Goal 安全降级和严格 Goal 控制

**文件：**

- 修改：`tools/codex-quota-guard/src/guard/state-machine.ts`
- 修改：`tools/codex-quota-guard/src/guard/controller.ts`
- 修改：`tools/codex-quota-guard/src/cli-runtime.ts`
- 修改：`tools/codex-quota-guard/test/controller.test.ts`
- 修改：`tools/codex-quota-guard/test/cli-runtime.test.ts`

- [ ] **步骤 1：写普通模式降级失败测试**

fake App Server 让 `thread/goal/get` 返回 `no such table: thread_goals`，但 `turn/interrupt` 和 terminal clean 成功。断言：

```ts
expect(state.lastThresholdEvent).toMatchObject({
  interruptSucceeded: true,
  goalPaused: false,
  goalErrorCategory: "goal_database_unavailable",
})
expect(state.goalControl).toBe("degraded")
expect(requestMethods).not.toContain("thread/goal/clear")
expect(state.guard.state).toBe("HANDLED")
```

- [ ] **步骤 2：写严格模式失败测试**

`run --require-goal-control` 在已有或显式 Goal 无法完成 get/pause/resume 时必须在 `turn/start` 前拒绝；普通 `--require-protection` 仍继续。无可验证 Goal 的新 thread 使用严格模式时明确要求提供 `--goal`，不得创建无法清除的临时 Goal。

- [ ] **步骤 3：运行测试并确认严格参数未生效**

运行：`npm test -- test/controller.test.ts test/cli-runtime.test.ts`

预期：goalControl/错误类别断言失败，严格模式仍错误放行。

- [ ] **步骤 4：实现 Goal 错误分类与独立状态**

```ts
export type GoalControlStatus = "runtimeVerified" | "schemaDetected" | "degraded" | "unavailable"
export type GoalErrorCategory =
  | "goal_database_unavailable"
  | "goal_schema_unavailable"
  | "goal_runtime_failed"
```

错误包含 `thread_goals`、`no such table` 或数据库不可用时分类为 database；schema 缺失为 schema；其他为 runtime。任何 Goal 错误都发生在精确 interrupt 之后，不提前返回。

- [ ] **步骤 5：实现严格 Goal 预检和策略持久化**

`limits.requireGoalControl` 与 `requireProtection` 分别保存。对已有 Goal 或显式 `--goal` 执行 get、paused、读取确认、恢复原状态；任一步失败拒绝 `turn/start`。`resume` 继承保存的严格 Goal 策略。

- [ ] **步骤 6：运行聚焦和核心保护测试并提交**

运行：`npm test -- test/controller.test.ts test/guard-state-machine.test.ts test/cli-runtime.test.ts`

预期：Goal 降级不影响中断；严格 Goal 失败时零 `turn/start`；weekly 和 HANDLED 行为全部通过。

提交：

```bash
git add tools/codex-quota-guard/src/guard tools/codex-quota-guard/src/cli-runtime.ts tools/codex-quota-guard/test/controller.test.ts tools/codex-quota-guard/test/cli-runtime.test.ts
git commit -m "feat: 分离 Goal 降级与额度中断保护"
```

## 任务七：阈值事件与精确中断时延审计

**文件：**

- 新建：`tools/codex-quota-guard/src/audit/timing.ts`
- 新建：`tools/codex-quota-guard/test/audit-timing.test.ts`
- 修改：`tools/codex-quota-guard/src/guard/state-machine.ts`
- 修改：`tools/codex-quota-guard/src/guard/controller.ts`
- 修改：`tools/codex-quota-guard/src/report/local-reporter.ts`
- 修改：`tools/codex-quota-guard/test/controller.test.ts`
- 修改：`tools/codex-quota-guard/test/reporter.test.ts`

- [ ] **步骤 1：写可空时延计算失败测试**

```ts
const audit = createAuditRecord("quotaThreshold")
observeAuditPoint(audit, "quotaSnapshotObserved", "2026-07-13T00:00:00.000Z", 100)
observeAuditPoint(audit, "thresholdDetected", "2026-07-13T00:00:00.010Z", 110)
observeAuditPoint(audit, "interruptRequested", "2026-07-13T00:00:00.015Z", 115)
observeAuditPoint(audit, "interruptAcknowledged", "2026-07-13T00:00:00.025Z", 125)
expect(finalizeLatencies(audit)).toMatchObject({
  snapshotToDetectionMs: 10,
  detectionToInterruptRequestMs: 5,
  interruptRequestToAcknowledgementMs: 10,
  interruptRequestToTerminalStateMs: null,
})
```

- [ ] **步骤 2：运行测试并确认审计模块不存在**

运行：`npm test -- test/audit-timing.test.ts`

预期：失败原因为模块不存在。

- [ ] **步骤 3：实现审计数据和注入时钟**

```ts
export interface AuditClock {
  utcNow(): string
  monotonicNow(): number
}

export interface EventAudit {
  eventKind: "quotaThreshold" | "liveCanary"
  quotaSnapshotObservedAt: string | null
  thresholdDetectedAt: string | null
  activeTurnResolvedAt: string | null
  interruptRequestedAt: string | null
  interruptAcknowledgedAt: string | null
  turnTerminalStateObservedAt: string | null
  goalPauseRequestedAt: string | null
  goalPauseAcknowledgedAt: string | null
  backgroundTerminalCleanedAt: string | null
  latencies: LatencyMetrics
}
```

单调时间点只保存在控制器内存映射中；状态和报告只保存 UTC 时间与已计算延迟。缺少点或跨进程恢复时对应延迟为 `null`。

- [ ] **步骤 4：写真实阈值事件时序失败测试**

用可控时钟依次推进观察、检测、请求、响应和 `turn/completed`，断言所有时间与四个延迟。Goal 失败时其 acknowledged 保持 null；terminal 通知缺失时终态和终态延迟保持 null。

- [ ] **步骤 5：运行控制器测试并确认事件缺少 audit**

运行：`npm test -- test/controller.test.ts test/reporter.test.ts`

预期：失败为 `lastThresholdEvent.audit` 或报告延迟字段缺失。

- [ ] **步骤 6：在不改边沿判定的前提下接入审计**

`state-machine.ts` 只给新事件初始化空 audit；`controller.ts` 在获得 transition event 后填观察/检测/固定 active turn 时间，在 `turn/interrupt` 前后填请求/响应时间，在匹配原目标的 `turn/completed` 或精确 `thread/read` 对账后填终态。收到终态后重写同一事件报告。

- [ ] **步骤 7：扩展 JSON 和 Markdown 报告**

报告列出 eventKind、全部 UTC 时间和四个可空延迟；继续调用 `sanitizeForPersistence`，不新增任何模型请求。

- [ ] **步骤 8：运行时延、报告和核心状态机测试并提交**

运行：`npm test -- test/audit-timing.test.ts test/controller.test.ts test/reporter.test.ts test/guard-state-machine.test.ts`

预期：全部通过；现有边沿用例的触发次数和固定 turn 断言不变。

提交：

```bash
git add tools/codex-quota-guard/src/audit tools/codex-quota-guard/src/guard tools/codex-quota-guard/src/report/local-reporter.ts tools/codex-quota-guard/test/audit-timing.test.ts tools/codex-quota-guard/test/controller.test.ts tools/codex-quota-guard/test/reporter.test.ts
git commit -m "feat: 记录额度中断的可审计时延"
```

## 任务八：doctor、status 与 live canary 可观测性

**文件：**

- 修改：`tools/codex-quota-guard/src/doctor.ts`
- 修改：`tools/codex-quota-guard/src/cli-runtime.ts`
- 修改：`tools/codex-quota-guard/src/ui/status.ts`
- 修改：`tools/codex-quota-guard/test/doctor.test.ts`
- 修改：`tools/codex-quota-guard/test/cli-runtime.test.ts`
- 修改：`tools/codex-quota-guard/test/ui.test.ts`

- [ ] **步骤 1：写 doctor 输出失败测试**

文本和 JSON 必须含：

```ts
expect(result).toMatchObject({
  codexExecutable: "/absolute/codex",
  executableRealPath: "/real/codex",
  executableSelectionSource: "environment",
  codexVersion: "codex-cli 0.144.0-alpha.4",
  protocolFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  appServerHandshake: true,
  rateLimitsRead: true,
})
expect(text).toContain("Turn interrupt: schemaDetected")
expect(text).toContain("Goal pause/resume: degraded")
```

逐项覆盖新增 thread/read、Goal resume 和 server request handling。

- [ ] **步骤 2：写 status JSON 向后兼容失败测试**

保留现有 `schemaVersion`、quota、guard、turns、active、limits 断言，并追加：

```ts
expect(output).toMatchObject({
  executable: {
    codexExecutable: "/absolute/codex",
    codexVersion: "codex-cli 0.131.0",
    executableSelectionSource: "path",
  },
  protocolFingerprint: "fingerprint",
  capabilities: expect.any(Object),
  goalControl: "degraded",
  runtimeChanges: [],
})
```

- [ ] **步骤 3：运行输出测试并确认新字段缺失**

运行：`npm test -- test/doctor.test.ts test/cli-runtime.test.ts test/ui.test.ts`

预期：新输出字段和五级状态断言失败；旧字段继续通过。

- [ ] **步骤 4：实现上下文和能力输出**

doctor 接收已经构造的上下文，不自行选择 `"codex"`。文本先显示 executable、source、version、fingerprint，再显示握手、额度和能力。status 构建器通过可选参数追加上下文，保持旧调用有效。

- [ ] **步骤 5：写普通 doctor 零模型和 canary 审计失败测试**

普通 doctor 请求列表不得包含 `turn/start`。live canary fake 测试保留双重确认，并断言 `eventKind: liveCanary`、请求/响应/终态时延；通知缺失时仅通过唯一 `thread/read` 目标中断和对账。

- [ ] **步骤 6：接入 canary 单调时钟和终态观察**

`runLiveCanary(client, { clock })` 在现有一次 turn 流程外围记录审计点。中断后等待匹配的 `turn/completed`；超时只调用 `thread/read`，恰有一个对应 turn 且为终态时记录，否则保持 null。不得启动第二个 turn 或自动重试。

- [ ] **步骤 7：运行输出与 canary 测试并提交**

运行：`npm test -- test/doctor.test.ts test/cli-runtime.test.ts test/ui.test.ts`

预期：普通 doctor 零 turn；canary 仍只有一个 turn；所有新增输出通过。

提交：

```bash
git add tools/codex-quota-guard/src/doctor.ts tools/codex-quota-guard/src/cli-runtime.ts tools/codex-quota-guard/src/ui/status.ts tools/codex-quota-guard/test/doctor.test.ts tools/codex-quota-guard/test/cli-runtime.test.ts tools/codex-quota-guard/test/ui.test.ts
git commit -m "feat: 完善运行环境与能力诊断输出"
```

## 任务九：脱敏、发布文档和版本号

**文件：**

- 修改：`tools/codex-quota-guard/src/persistence/state-store.ts`
- 修改：`tools/codex-quota-guard/src/app-server/process-connection.ts`
- 修改：`tools/codex-quota-guard/test/persistence.test.ts`
- 修改：`tools/codex-quota-guard/test/process-connection.test.ts`
- 修改：`tools/codex-quota-guard/package.json`
- 修改：`tools/codex-quota-guard/package-lock.json`
- 修改：`tools/codex-quota-guard/README.md`
- 新建：`tools/codex-quota-guard/CHANGELOG.md`
- 新建：`tools/codex-quota-guard/RELEASE_CHECKLIST.md`
- 修改：`.github/workflows/codex-quota-guard.yml`

- [ ] **步骤 1：写新字段脱敏失败测试**

把 `token`、`cookie`、`authorization`、`secret` 放入 resolver 错误 detail、runtimeChanges、能力 detail、audit 错误和 server diagnostic，保存状态及报告后断言原值均不存在。

- [ ] **步骤 2：运行安全测试并确认至少一个新路径泄漏**

运行：`npm test -- test/persistence.test.ts test/reporter.test.ts test/process-connection.test.ts`

预期：新增敏感样例至少一个失败，证明新路径必须统一脱敏。

- [ ] **步骤 3：统一复用脱敏函数**

把字符串脱敏导出为 `sanitizeDiagnostic(value: string)`，状态、报告、resolver 错误和 App Server stderr 共用；敏感键过滤继续递归处理对象。

- [ ] **步骤 4：升级版本并更新锁文件**

把独立包版本改为 `0.2.0`，运行：`npm install --package-lock-only --ignore-scripts --cache /private/tmp/codex-quota-guard-npm-cache`

预期：仅独立 `package.json` 和 `package-lock.json` 的版本字段变化，不修改根 package 文件。

- [ ] **步骤 5：编写 README、CHANGELOG 和发布检查清单**

README 必须逐项说明：工具只控制自己启动的 App Server；四种选择来源；`--codex-path`、环境变量和 `.codex-guard/config.json`；PATH 与应用内置版本差异；候选绝不自动启动；schema/runtime 区别；Goal 降级不等于 interrupt 失效；DORMANT + ALLOWED；weekly 永不 interrupt；不能数学精确停在 2.000%；macOS canary 与跨平台 fake CI 边界；live canary 的真实额度消耗；安装、卸载、tarball 临时安装。

CHANGELOG 使用 `0.2.0` 条目列出新增能力和兼容保证。RELEASE_CHECKLIST 列出本目标第九节全部命令、仓库外 smoke、三种 resolver 来源、三平台 CI、无真实 canary、范围审计。

- [ ] **步骤 6：更新专属 workflow**

矩阵继续使用 macOS、Ubuntu、Windows 和 Node 20.19.0；在现有步骤中加入 `npm ls --depth=0`，保留格式、类型、全部 fake 测试、构建和 `npm pack --dry-run`。不得修改根 CI。

- [ ] **步骤 7：运行文档相关格式、安全和打包检查并提交**

运行：`npm run format:check`

运行：`npm test -- test/persistence.test.ts test/reporter.test.ts test/process-connection.test.ts`

运行：`npm pack --dry-run --cache /private/tmp/codex-quota-guard-npm-cache`

预期：全部通过，tarball 含 README、CHANGELOG、RELEASE_CHECKLIST 和 dist，不含测试、状态或认证文件。若 `files` 白名单未包含新文档，先把两份文档加入 `package.json.files` 再重跑。

提交：

```bash
git add .github/workflows/codex-quota-guard.yml tools/codex-quota-guard
git commit -m "docs: 准备 Codex Quota Guard 0.2.0 发布"
```

## 任务十：完整验证、临时安装和三平台验收

**文件：**

- 修改：`docs/codex-quota-guard-plan.md`，只记录实际结果和限制

- [ ] **步骤 1：执行干净依赖安装**

运行：`npm ci --ignore-scripts --cache /private/tmp/codex-quota-guard-npm-cache`

预期：退出码 0，不运行真实 Codex。

- [ ] **步骤 2：执行全部本地质量门**

依次运行：

```bash
npm test
npm run typecheck
npm run format:check
npm run build
npm ls --depth=0
npm pack --dry-run --cache /private/tmp/codex-quota-guard-npm-cache
```

预期：全部退出码 0；测试总数不少于原有 86 项加本计划新增用例；无测试调用真实模型。

- [ ] **步骤 3：生成真实 tgz 并安装到临时 prefix**

在工具目录运行：

```bash
npm pack --pack-destination /private/tmp --cache /private/tmp/codex-quota-guard-npm-cache
npm install --prefix /private/tmp/codex-quota-guard-prefix /private/tmp/codex-quota-guard-0.2.0.tgz --ignore-scripts --cache /private/tmp/codex-quota-guard-npm-cache
```

预期：安装生成 `/private/tmp/codex-quota-guard-prefix/bin/codex-quota-guard` 或平台等价入口。

- [ ] **步骤 4：从仓库外验证 help 和三种 resolver 来源**

工作目录使用新建的 `/private/tmp/codex-quota-guard-smoke-project`。分别运行：

```bash
/private/tmp/codex-quota-guard-prefix/bin/codex-quota-guard --help
/private/tmp/codex-quota-guard-prefix/bin/codex-quota-guard status --json
/private/tmp/codex-quota-guard-prefix/bin/codex-quota-guard doctor --json
/private/tmp/codex-quota-guard-prefix/bin/codex-quota-guard doctor --codex-path "/Applications/ChatGPT.app/Contents/Resources/codex" --json
CODEX_QUOTA_GUARD_CODEX_PATH="/Users/wuluofei/.hermes/node/bin/codex" /private/tmp/codex-quota-guard-prefix/bin/codex-quota-guard doctor --json
```

预期：help 不启动 App Server；默认输出 source=path；显式路径输出 source=cli；环境变量输出 source=environment；实际路径、版本和指纹分别与所选文件一致。`status` 和普通 doctor 只握手及读取额度，不调用 `turn/start`。

- [ ] **步骤 5：验证项目配置来源且不污染其他目录**

在 smoke 项目的 `.codex-guard/config.json` 写入：

```json
{
  "codexPath": "/Applications/ChatGPT.app/Contents/Resources/codex"
}
```

运行 doctor 断言 source=config；切换到第二个空临时目录后运行 doctor，断言仍使用 PATH 而不是前一目录配置。

- [ ] **步骤 6：记录实际两套 Codex 的安全探测结果**

记录 PATH Codex 和 ChatGPT 内置 Codex 的绝对路径、真实路径、`--version`、协议指纹、握手、额度读取和能力矩阵。只记录普通 doctor 结果；本轮不执行 `--live-canary`，不启动真实 turn。

- [ ] **步骤 7：执行范围和核心行为审计**

运行：

```bash
git diff --check
git status --short
git diff c6a6a99..HEAD --name-only
```

预期：变更只在 `tools/codex-quota-guard/**`、计划文档和专属 workflow。再次运行 `test/guard-state-machine.test.ts`，逐项核对 300 分钟窗口、weekly、HANDLED、DORMANT、固定 turn 和一次性中断。

- [ ] **步骤 8：提交本地验收记录并推送功能分支**

只在计划文档追加实际命令、退出码、测试数量、两套 Codex 结果和未执行 canary 的说明。提交并推送 `codex-quota-guard` 分支，不创建或修改无关远端内容。

- [ ] **步骤 9：等待最终提交对应的三平台 GitHub Actions**

显式查询 `nan-doctor/llm_wiki` 中最终 HEAD 的 `Codex Quota Guard` workflow。macOS、Ubuntu、Windows 三个 job 都必须完成并成功；任何平台失败都回到对应测试先行任务修复，不能用上一提交的绿色结果替代。

- [ ] **步骤 10：最终完成度审计**

逐条对照目标的 10 个章节、20 项新增测试和 14 项完成标准。只有每项都有直接文件、测试、命令或 CI 证据且没有未说明假设，才调用 Goal complete；否则继续实施或准确报告剩余缺口。

## 需求覆盖映射

- 新增测试 1—4：任务一和任务二，覆盖 CLI、环境、配置、PATH 优先级与空格路径。
- 新增测试 5—9：任务二，覆盖不存在、不可执行、版本失败、App Server 不可用和禁止静默回退。
- 新增测试 10：任务六，覆盖 Goal 数据库降级、普通模式放行和严格 Goal 拒绝。
- 新增测试 11—14：任务五，覆盖路径、版本、指纹变化和 runtime 证据失效后重新探测。
- 新增测试 15：任务三和任务八，覆盖 schema detected 与 runtime verified 的数据和输出分离。
- 新增测试 16—17：任务七和任务八，覆盖阈值事件、canary、缺失通知及 thread/read 对账时延。
- 新增测试 18：任务九，覆盖状态、报告、错误和 App Server 诊断的统一脱敏。
- 新增测试 19：任务二，覆盖 macOS、Linux、Windows 的 PATH/PATHEXT 与候选语义。
- 新增测试 20：任务四至任务八的每轮完整测试，以及任务十的专项核心状态机审计。
- 完成标准 1—3：任务四至任务八的回归测试和任务十完整质量门。
- 完成标准 4—7：任务二、任务三、任务四和任务八。
- 完成标准 8—10：任务五、任务六和任务七。
- 完成标准 11—12：任务十的 tgz 仓库外安装与最终 HEAD 三平台 Actions。
- 完成标准 13：任务九的 README、CHANGELOG 和 RELEASE_CHECKLIST。
- 完成标准 14：任务十记录两套实际 Codex 的安全探测结果、未执行 canary 说明和逐项审计。

## 0.2.0 实际验收记录（2026-07-13）

### 本地质量门

- `npm ci --ignore-scripts --cache /private/tmp/codex-quota-guard-npm-cache`：退出码 0，干净安装 48 个包。
- `npm test`：退出码 0，16 个测试文件、130 项测试全部通过；全部使用 fake App Server，没有调用真实模型。
- `npm run typecheck`、`npm run format:check`、`npm run build`、`npm ls --depth=0`、`npm pack --dry-run`：均退出码 0。
- `npm pack` 生成 `codex-quota-guard-0.2.0.tgz`，共 30 个文件；包含 README、CHANGELOG、RELEASE_CHECKLIST 和 dist，不包含测试、`.codex-guard` 状态或认证文件。
- tgz 安装到临时 prefix 后，macOS 平台等价入口位于 `node_modules/.bin/codex-quota-guard`；从仓库外目录执行 `--help` 成功，且帮助明确显示 `--codex-path <绝对路径>`。

### resolver 与仓库外冒烟

- 默认 `status --json` 和普通 `doctor --json`：`executableSelectionSource=path`。
- `doctor --codex-path /Applications/ChatGPT.app/Contents/Resources/codex --json`：`executableSelectionSource=cli`。
- `CODEX_QUOTA_GUARD_CODEX_PATH=/Applications/ChatGPT.app/Contents/Resources/codex doctor --json`：`executableSelectionSource=environment`。
- 临时项目 `.codex-guard/config.json`：`executableSelectionSource=config`；切换到第二个空目录后恢复为 `path`，证明项目配置没有跨目录污染。
- 同一 PATH Codex 连续两次 `status --json` 均得到协议指纹 `0e6e3124e7a98215157f57704470f1e9c56f920e52962068b5c6f27c9bf893cd` 且 `runtimeChanges=[]`。实机验收曾发现生成 schema 的对象键顺序不稳定；已增加规范化 JSON 指纹和回归测试，不再产生虚假协议漂移。

### 实际 Codex 安全探测

PATH Codex：

- 选择路径：`/Users/wuluofei/.hermes/node/bin/codex`
- 真实路径：`/Users/wuluofei/.hermes/node/lib/node_modules/@openai/codex/bin/codex.js`
- 版本：`codex-cli 0.131.0`
- 协议指纹：`0e6e3124e7a98215157f57704470f1e9c56f920e52962068b5c6f27c9bf893cd`
- App Server 握手：成功；`account/rateLimits/read`：运行时验证成功。
- schema：额度读取/更新、turn start/interrupt、thread read、Goal get/set/paused/resume、后台 terminal clean、双向 server request 全部存在。
- 普通 doctor 未调用模型，因此除额度读取外的上述能力保持 `schemaDetected`，没有伪造 `runtimeVerified`。

ChatGPT 应用内置 Codex：

- 选择和真实路径：`/Applications/ChatGPT.app/Contents/Resources/codex`
- 版本：`codex-cli 0.144.0-alpha.4`
- 协议指纹：`2d5ff146d8cce80e45fbd35d05af9b42ece75ee75c8349ef98ee76831d0e258d`
- App Server 握手：成功；`account/rateLimits/read`：运行时验证成功。
- schema：与 PATH Codex 相同的 11 项目标能力全部存在；版本未列入本工具已认证版本，因此兼容性依据明确标为现场生成 schema。
- 普通 doctor 未调用模型，除额度读取外的能力保持 `schemaDetected`。

两套 Codex 的当前额度快照都只返回 weekly，没有有效 300 分钟窗口。普通 doctor 正确返回 `degraded` 而非 `failed`；`status` 显示 `guard=DORMANT`、`turns=ALLOWED`，没有用 weekly 触发中断。

### 真实调用边界与最终 CI

- 本轮没有执行 `doctor --live-canary`，没有启动真实模型 turn。
- 普通 status/doctor 只完成 schema 生成、App Server 握手和额度读取。
- 最终提交推送后查询该 SHA 对应的 Codex Quota Guard 三平台 workflow；为避免“记录 CI 结果”本身产生新的未验证提交，最终 CI 结果保留在任务完成报告中，不再回写计划文档。

# Codex Quota Guard 默认终端启动器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有五小时额度状态机语义的前提下，让无参数 `codex` 通过可逆的当前 shell shim 打开由 Quota Guard 单连接代理保护的原生 Codex TUI。

**Architecture:** 原生 TUI 只连接随机本地 WebSocket endpoint，Quota Guard 是真实 stdio App Server 的唯一客户端，并在透明双向转发中观察额度、thread 和 turn 通知以及注入精确中断。全局配置、shell 安装和原始旁路位于现有项目级状态之外；交互会话通过现有 `GuardController` 和 `RuntimeContext` 复用额度、Goal、报告与 resolver 行为。

**Tech Stack:** TypeScript、Node.js 20、Vitest、`ws`、Codex App Server JSON-RPC、stdio JSONL、全平台 loopback WebSocket。

---

## 实施前固定边界

- 执行工作目录：`tools/codex-quota-guard/`；本文中的命令除特别说明外均在该目录运行。
- 设计依据：[默认终端启动器设计](superpowers/specs/2026-07-13-codex-quota-guard-default-terminal-design.md)。若实施发现当前 Codex remote 协议不支持安全透明代理，立即停止默认 `codex` 接管，保留 `codex-guarded` 退化入口，不采用终端抓取或双客户端连接。
- 不修改 `applyQuotaObservation`、`applyStaleQuota` 的 300 分钟窗口选择、2% 下降沿、同 windowKey 一次性处理或 `HANDLED` 放行规则。
- 不修改仓库根 `package.json`、根 TypeScript/Vitest 配置或主应用业务代码；唯一允许的仓库级文件是 `.github/workflows/codex-quota-guard.yml`。
- 自动测试只能启动 fake TUI、fake App Server 或 fake Codex，可执行文件；不得调用真实模型、真实 `turn/start` 或真实 live canary。
- 版本按新增向后兼容功能升级为 `0.3.0`。

## 文件职责图

### 新建源码

- `src/app-server/client.ts`：GuardController 依赖的最小 App Server 客户端接口和带会话 generation 的通知类型。
- `src/proxy/json-rpc.ts`：宽松 JSON-RPC 消息、ID、错误和消息判别函数；不使用方法白名单。
- `src/proxy/raw-app-server-process.ts`：真实 `codex app-server --listen stdio://` 的原始 JSONL 进程传输，不自行 initialize。
- `src/proxy/transparent-proxy.ts`：TUI 请求 ID 映射、Guard ID 命名空间、双向 server request、未知消息透传和首个 turn 门控。
- `src/proxy/local-tui-endpoint.ts`：只监听 `127.0.0.1` 随机端口的 WebSocket、本地 capability token 校验和单客户端限制。
- `src/proxy/interactive-app-server-client.ts`：在 TUI 握手后向代理注入额度读取，监听额度更新，并实现 Guard 客户端接口。
- `src/interactive/preflight.ts`：短生命周期 App Server 预检、状态输出和严格保护准入。
- `src/interactive/tui-process.ts`：以真实绝对路径和受控参数启动原生 TUI，保留原终端输入输出。
- `src/interactive/session.ts`：交互组件启动顺序、信号处理、幂等逆序清理和退出码传播。
- `src/runtime/remote-capabilities.ts`：解析同一真实 Codex 的 `--help` 和 `app-server --help`，形成 remote TUI 与传输准入证据。
- `src/persistence/global-config-store.ts`：平台用户数据目录中的原子全局配置，不保存任何认证材料。
- `src/shell/current-shell.ts`：只识别当前 zsh、bash 或 PowerShell 及其 profile。
- `src/shell/profile-block.ts`：创建、检查和精确移除唯一 PATH 标记块。
- `src/shell/shim-template.ts`：生成带所有权标记和校验的 `codex`、`codex-raw` shim。
- `src/shell/installer.ts`：install/status/uninstall 事务、确认、回滚和解析验证。
- `src/shell/router.ts`：guarded interactive、raw、BYPASS、管理命令、`exec`、版本和未知子命令的纯路由。
- `src/process/run-child.ts`：以 `stdio: inherit` 启动精确绝对路径并传播退出码或信号。

### 新建测试与 fake

- `test/raw-app-server-process.test.ts`
- `test/transparent-proxy.test.ts`
- `test/local-tui-endpoint.test.ts`
- `test/interactive-app-server-client.test.ts`
- `test/interactive-session.test.ts`
- `test/remote-capabilities.test.ts`
- `test/global-config-store.test.ts`
- `test/current-shell.test.ts`
- `test/profile-block.test.ts`
- `test/shell-installer.test.ts`
- `test/shell-router.test.ts`
- `test/interactive-e2e.test.ts`
- `test/fakes/fake-jsonl-app-server.mjs`
- `test/fakes/fake-remote-tui.mjs`
- `test/fakes/fake-codex.mjs`

### 修改现有文件

- `src/app-server/manager.ts`：显式实现最小客户端接口；现有重连行为不变。
- `src/app-server/protocol.ts`：只保留现有领域类型；宽松代理类型移入新文件。
- `src/guard/controller.ts`：依赖接口、观察交互 thread/turn、清理陈旧 active turn 和提供精确会话关闭；阈值处理主体不改。
- `src/guard/state-machine.ts`、`src/persistence/state-store.ts`：增加可选迁移的 `activeThreadId`，不改变状态转移。
- `src/ui/status.ts`：JSON 增加 active thread，交互启动复用现有 quota/guard/turns 分离显示。
- `src/cli-args.ts`、`src/cli-runtime.ts`、`src/cli.ts`：新增 interactive、config、shell 和内部 shim dispatch。
- `package.json`、`package-lock.json`：加入 `ws`、类型依赖和 `0.3.0`。
- `README.md`、`CHANGELOG.md`、`RELEASE_CHECKLIST.md`：说明默认终端入口、旁路、安全边界、恢复和验收。
- `.github/workflows/codex-quota-guard.yml`：保持三平台矩阵并运行新增 fake 端到端测试。

## 任务一：抽取 Guard 客户端契约，保持现有控制器行为

**文件：**

- 新建：`tools/codex-quota-guard/src/app-server/client.ts`
- 修改：`tools/codex-quota-guard/src/app-server/manager.ts`
- 修改：`tools/codex-quota-guard/src/guard/controller.ts`
- 修改：`tools/codex-quota-guard/test/controller.test.ts`

- [ ] **步骤 1：写结构接口失败测试**

在 `test/controller.test.ts` 增加一个只实现最小接口、不继承 `AppServerManager` 的 fake，并沿用现有安全额度响应：

```ts
class FakeGuardClient extends EventEmitter implements GuardAppServerClient {
  currentRateLimits: GetAccountRateLimitsResponse | null = response(snapshot())
  async start(): Promise<void> {
    this.emit("rateLimits", this.currentRateLimits)
  }
  async stop(): Promise<void> {}
  async request<T>(): Promise<T> {
    throw new Error("本测试不应请求 turn")
  }
  async refreshRateLimits(): Promise<GetAccountRateLimitsResponse> {
    this.emit("rateLimits", this.currentRateLimits)
    return this.currentRateLimits!
  }
  async waitForIdle(): Promise<void> {}
}

it("控制器只依赖 GuardAppServerClient 契约", async () => {
  const client = new FakeGuardClient()
  const controller = new GuardController(client, repository(), reporter())
  await controller.start()
  expect(controller.status().state.quota?.protectedRemainingPercent).toBe(80)
  await controller.stop()
})
```

- [ ] **步骤 2：运行聚焦测试并确认类型失败**

运行：`npm test -- test/controller.test.ts`

预期：TypeScript/Vitest 因 `GuardController` 仍要求具体 `AppServerManager` 或缺少 `GuardAppServerClient` 而失败；现有额度断言没有行为性失败。

- [ ] **步骤 3：增加最小客户端接口并替换构造类型**

新建 `src/app-server/client.ts`：

```ts
import type { EventEmitter } from "node:events"
import type { GetAccountRateLimitsResponse } from "./protocol.js"

export interface GuardNotification {
  method: string
  params?: unknown
  sessionGeneration?: string
}

export interface GuardAppServerClient extends EventEmitter {
  currentRateLimits: GetAccountRateLimitsResponse | null
  start(): Promise<void>
  stop(): Promise<void>
  request<T>(method: string, params?: unknown): Promise<T>
  refreshRateLimits(): Promise<GetAccountRateLimitsResponse>
  waitForIdle(): Promise<void>
}
```

让 `AppServerManager` 声明 `implements GuardAppServerClient`，通知参数使用 `GuardNotification`。把 `GuardController` 的构造参数类型从 `AppServerManager` 改为 `GuardAppServerClient`；不得移动或改写 `handleThresholdEvent`。

- [ ] **步骤 4：运行回归测试和类型检查**

运行：`npm test -- test/app-server-manager.test.ts test/controller.test.ts && npm run typecheck`

预期：全部通过；现有重连、额度刷新、精确中断、Goal 降级和 300 分钟状态机测试结果不变。

- [ ] **步骤 5：提交客户端契约**

```bash
git add tools/codex-quota-guard/src/app-server/client.ts tools/codex-quota-guard/src/app-server/manager.ts tools/codex-quota-guard/src/guard/controller.ts tools/codex-quota-guard/test/controller.test.ts
git commit -m "refactor: 抽取交互会话共用的 App Server 客户端契约"
```

## 任务二：实现不解释协议方法的原始 App Server 传输

**文件：**

- 新建：`tools/codex-quota-guard/src/proxy/json-rpc.ts`
- 新建：`tools/codex-quota-guard/src/proxy/raw-app-server-process.ts`
- 新建：`tools/codex-quota-guard/test/raw-app-server-process.test.ts`
- 新建：`tools/codex-quota-guard/test/fakes/fake-jsonl-app-server.mjs`

- [ ] **步骤 1：写任意消息往返和退出失败测试**

测试用 `process.execPath` 启动 fake 脚本，fake 逐行发送未知通知、字符串 ID 的 server request 和带未知字段的响应。核心断言：

```ts
it("完整保留未知 JSON-RPC 消息并拒绝退出时的 pending 等待", async () => {
  const processTransport = new RawAppServerProcess({
    codexPath: process.execPath,
    codexArgsPrefix: [fakeScript],
    enableGoals: false,
  })
  const received: JsonRpcMessage[] = []
  processTransport.on("message", (message) => received.push(message))
  await processTransport.start()
  processTransport.send({ id: "tui-1", method: "unknown/request", params: { kept: true } })
  await once(processTransport, "idle")
  expect(received).toContainEqual(expect.objectContaining({
    id: "tui-1",
    result: { kept: true },
    extensionField: "preserved",
  }))
  await processTransport.stop()
})
```

另断言实际 spawn 参数包含 `app-server --listen stdio://`，不包含 `initialize`；stderr 中的 Bearer/token 被脱敏。

- [ ] **步骤 2：运行测试并确认模块缺失**

运行：`npm test -- test/raw-app-server-process.test.ts`

预期：因新模块不存在而失败，且没有启动真实 Codex。

- [ ] **步骤 3：定义宽松 JSON-RPC 类型与判别函数**

`src/proxy/json-rpc.ts` 使用开放字段，禁止把未知字段丢进窄类型：

```ts
export type JsonRpcId = string | number | null

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
  [key: string]: unknown
}

export interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
  result?: unknown
  error?: JsonRpcErrorObject
  [key: string]: unknown
}

export function parseJsonRpcMessage(line: string): JsonRpcMessage {
  const value = JSON.parse(line) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("App Server 输出必须是 JSON 对象")
  }
  return value as JsonRpcMessage
}

export function hasMethod(message: JsonRpcMessage): boolean {
  return typeof message.method === "string"
}

export function hasId(message: JsonRpcMessage): boolean {
  return Object.prototype.hasOwnProperty.call(message, "id")
}

export function withId(message: JsonRpcMessage, id: JsonRpcId): JsonRpcMessage {
  return { ...message, id }
}
```

- [ ] **步骤 4：实现原始进程传输**

`RawAppServerProcess` 继承 `EventEmitter`，公开接口固定为：

```ts
export interface RawAppServerProcessOptions {
  codexPath: string
  codexArgsPrefix?: string[]
  enableGoals?: boolean
  environment?: NodeJS.ProcessEnv
}

export class RawAppServerProcess extends EventEmitter {
  async start(): Promise<void>
  send(message: JsonRpcMessage): void
  async stop(): Promise<void>
}
```

`start()` 只 spawn 以下参数并逐行发出 `message`：

```ts
const args = [
  ...options.codexArgsPrefix ?? [],
  ...options.enableGoals ? ["--enable", "goals"] : [],
  "app-server",
  "--listen",
  "stdio://",
]
```

stdout 解析失败只发出脱敏 `diagnostic`；`send()` 对原对象执行一次 `JSON.stringify` 后写入 stdin；`stop()` 幂等发送温和终止并等待退出，超时后强制结束；非主动退出发出一次 `exit`。真实 App Server 子进程必须在生成 capability token 前启动，因此 `environment` 不能包含 `CODEX_QUOTA_GUARD_REMOTE_TOKEN`。

- [ ] **步骤 5：运行传输测试并提交**

运行：`npm test -- test/raw-app-server-process.test.ts test/process-connection.test.ts && npm run typecheck`

预期：任意消息和未知字段逐字义往返；原有单轮 `ProcessAppServerConnection` 仍明确拒绝 server request，未被修改。

```bash
git add tools/codex-quota-guard/src/proxy tools/codex-quota-guard/test/raw-app-server-process.test.ts tools/codex-quota-guard/test/fakes/fake-jsonl-app-server.mjs
git commit -m "feat: 增加透明代理使用的原始 App Server 传输"
```

## 任务三：实现双向透明代理和独立请求 ID 命名空间

**文件：**

- 新建：`tools/codex-quota-guard/src/proxy/transparent-proxy.ts`
- 新建：`tools/codex-quota-guard/test/transparent-proxy.test.ts`

当前安装版本现场生成的 `RequestId.json` 明确以 `anyOf` 接受 `string` 和 `int64`，因此本任务使用字符串前缀是协议允许的 ID，不依赖未记录接口。

- [ ] **步骤 1：写 ID、server request 和未知消息失败测试**

用内存 peer 覆盖以下表格，每行都断言除 `id` 外深度相等：

```ts
it.each([
  [1, { result: { ok: true }, unknown: "kept" }],
  ["request-1", { error: { code: -32000, message: "x", data: { kept: true } } }],
])("恢复 TUI 的原始 ID %s", async (originalId, response) => {
  downstream.emitMessage({ id: originalId, method: "unknown/method", params: { x: 1 } })
  const forwarded = upstream.sent.at(-1)!
  expect(String(forwarded.id)).toMatch(/^cqg-tui:/)
  upstream.emitMessage({ id: forwarded.id, ...response })
  expect(downstream.sent.at(-1)).toEqual({ id: originalId, ...response })
})
```

另写测试证明：

- App Server 的 `{id: 1, method: "item/commandExecution/requestApproval"}` 原 ID 到达 TUI，TUI `{id: 1, result: ...}` 原样回到 App Server；
- 同时存在数值 ID `1` 的 TUI 请求、server request 和 Guard 请求时互不混淆；
- 未知通知、`jsonrpc` 和扩展字段透明保留；
- Guard 响应只完成 Guard promise，不发送给 TUI；
- Guard 请求超时不伪造 TUI 响应；
- 首次遇到 `turn/start` 后暂停该消息及其后所有 TUI 上行消息，开门后保持原顺序释放。

- [ ] **步骤 2：运行代理测试并确认模块缺失**

运行：`npm test -- test/transparent-proxy.test.ts`

预期：因 `TransparentJsonRpcProxy` 不存在而失败。

- [ ] **步骤 3：实现端口契约、ID 映射和 Guard pending**

使用以下公开接口，端口只处理消息，不关心 WebSocket 或 stdio：

```ts
export interface JsonRpcPeer extends EventEmitter {
  send(message: JsonRpcMessage): void
}

export interface TransparentProxyOptions {
  sessionNonce: string
  requestTimeoutMs?: number
}

export class TransparentJsonRpcProxy extends EventEmitter {
  constructor(
    private readonly downstream: JsonRpcPeer,
    private readonly upstream: JsonRpcPeer,
    private readonly options: TransparentProxyOptions,
  )
  start(): void
  stop(error?: Error): void
  request<T>(method: string, params?: unknown): Promise<T>
  openTurnGate(): void
}
```

TUI 请求映射保存 `{originalId, method}`，上游 ID 为 `cqg-tui:<nonce>:<counter>`；Guard ID 为 `cqg-guard:<nonce>:<counter>`，使用独立计数器。TUI 对 server request 的响应没有映射记录，必须原样上行。上游带 `method` 的请求或通知先发出只读 `notification`/`serverRequest` 观察事件，再原样下行。所有映射和 pending 在 `stop()` 中拒绝并清空。

- [ ] **步骤 4：实现首个 turn 的顺序门**

在门未打开时，初始化和只读消息正常转发；一旦遇到第一个 `turn/start`，把它和后续上行消息放入 FIFO：

```ts
private forwardOrQueue(message: JsonRpcMessage): void {
  if (!this.turnGateOpen && (this.turnQueue.length > 0 || message.method === "turn/start")) {
    this.turnQueue.push(message)
    return
  }
  this.forwardTuiMessage(message)
}

openTurnGate(): void {
  if (this.turnGateOpen) return
  this.turnGateOpen = true
  for (const message of this.turnQueue.splice(0)) this.forwardTuiMessage(message)
}
```

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- test/transparent-proxy.test.ts && npm run typecheck`

预期：数字/字符串 ID、双向 server request、审批、未知方法、未知字段、Guard 注入和门控全部通过。

```bash
git add tools/codex-quota-guard/src/proxy/transparent-proxy.ts tools/codex-quota-guard/test/transparent-proxy.test.ts
git commit -m "feat: 实现单连接 JSON-RPC 透明代理"
```

## 任务四：实现经过认证的单客户端本地 endpoint

**文件：**

- 新建：`tools/codex-quota-guard/src/proxy/local-tui-endpoint.ts`
- 新建：`tools/codex-quota-guard/test/local-tui-endpoint.test.ts`
- 修改：`tools/codex-quota-guard/package.json`
- 修改：`tools/codex-quota-guard/package-lock.json`

- [ ] **步骤 1：安装明确版本的 WebSocket 依赖**

运行：

```bash
npm install ws@^8.18.3 --save
npm install @types/ws@^8.18.1 --save-dev
```

预期：只有独立工具的 `package.json` 和 `package-lock.json` 改变；`ws` 位于 `dependencies`，`@types/ws` 位于 `devDependencies`。

- [ ] **步骤 2：写全平台 loopback、token 和单客户端失败测试**

测试通过注入 `platform` 覆盖 macOS、Linux 和 Windows：

```ts
it("拒绝错误 token 和第二个客户端且不创建 token 文件", async () => {
  const endpoint = await LocalTuiEndpoint.create({ platform: "darwin", token: "secret" })
  await expect(connect(endpoint.address, "wrong")).rejects.toThrow()
  const first = await connect(endpoint.address, "secret")
  await expect(connect(endpoint.address, "secret")).rejects.toThrow()
  expect(endpoint.address).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
  expect(endpoint.address).not.toContain("secret")
  first.close()
  await endpoint.stop()
})
```

所有平台都断言地址匹配 `ws://127.0.0.1:<随机端口>`，server address 不是 `0.0.0.0` 或 `::`，错误 token 返回 401，第二个客户端返回 409。当前 Codex 的 `--remote` 帮助明确规定 `--remote-auth-token-env` 只能与 `wss://` 或 loopback `ws://` 组合；为保留认证，macOS/Linux 不使用 `unix://`。

- [ ] **步骤 3：运行测试并确认 endpoint 缺失**

运行：`npm test -- test/local-tui-endpoint.test.ts`

预期：模块缺失或连接未实现导致失败。

- [ ] **步骤 4：实现 HTTP Upgrade、常量时间认证和 JsonRpcPeer**

公开结果固定为：

```ts
export interface LocalTuiEndpointOptions {
  platform: NodeJS.Platform
  token: string
}

export class LocalTuiEndpoint extends EventEmitter implements JsonRpcPeer {
  readonly address: string
  readonly temporaryDirectory: string | null
  static create(options: LocalTuiEndpointOptions): Promise<LocalTuiEndpoint>
  send(message: JsonRpcMessage): void
  closeClient(code?: number, reason?: string): Promise<void>
  stop(): Promise<void>
}
```

Upgrade 只接受完全匹配的 Bearer 值：

```ts
function tokenMatches(header: string | undefined, expected: string): boolean {
  const actual = header?.startsWith("Bearer ") ? header.slice(7) : ""
  const left = createHash("sha256").update(actual).digest()
  const right = createHash("sha256").update(expected).digest()
  return timingSafeEqual(left, right)
}
```

token 只存在构造参数闭包和调用者内存；不得写文件、发出 diagnostic 或进入 endpoint 地址。`closeClient()` 只关闭当前 TUI WebSocket，`stop()` 再幂等关闭只监听 loopback 的 HTTP server 并移除监听器。`temporaryDirectory` 为兼容清理审计固定返回 `null`。

- [ ] **步骤 5：运行 endpoint、安全和依赖检查并提交**

运行：`npm test -- test/local-tui-endpoint.test.ts && npm run typecheck && npm ls --depth=0`

预期：三平台 loopback 行为通过；依赖树只有声明的 `ws` 与开发依赖，没有未声明包。

```bash
git add tools/codex-quota-guard/package.json tools/codex-quota-guard/package-lock.json tools/codex-quota-guard/src/proxy/local-tui-endpoint.ts tools/codex-quota-guard/test/local-tui-endpoint.test.ts
git commit -m "feat: 增加受认证的本地 TUI endpoint"
```

## 任务五：在 TUI 握手后建立 Guard 额度客户端

**文件：**

- 新建：`tools/codex-quota-guard/src/proxy/interactive-app-server-client.ts`
- 新建：`tools/codex-quota-guard/test/interactive-app-server-client.test.ts`

- [ ] **步骤 1：写握手、首次额度和更新合并失败测试**

使用内存代理验证以下顺序：

```ts
it("initialized 后先读取额度再释放 turn/start", async () => {
  const client = new InteractiveAppServerClient(proxy, {
    sessionGeneration: "session-1",
    initializedTimeoutMs: 100,
    notificationRefreshDelayMs: 1,
  })
  const start = client.start()
  proxy.emit("tuiNotification", { method: "initialized" })
  expect(proxy.guardRequests[0]?.method).toBe("account/rateLimits/read")
  proxy.resolveGuardRequest(0, response(snapshot()))
  await start
  expect(client.currentRateLimits).toEqual(response(snapshot()))
  expect(proxy.turnGateOpened).toBe(true)
})
```

再连续发出三次 `account/rateLimits/updated`，断言只注入一次延迟读取；读取结果发出 `rateLimits`，原三条通知仍由透明代理下发 TUI。握手超时、代理退出和额度读取失败均拒绝 `start()`，且门保持关闭。

- [ ] **步骤 2：运行测试并确认客户端缺失**

运行：`npm test -- test/interactive-app-server-client.test.ts`

预期：因模块不存在而失败。

- [ ] **步骤 3：实现 Guard 客户端接口**

客户端继承 `EventEmitter` 并公开与现有 manager 相同的最小行为：

```ts
export interface InteractiveAppServerClientOptions {
  sessionGeneration: string
  initializedTimeoutMs?: number
  notificationRefreshDelayMs?: number
}

export class InteractiveAppServerClient extends EventEmitter
  implements GuardAppServerClient {
  currentRateLimits: GetAccountRateLimitsResponse | null = null
  async start(): Promise<void>
  async stop(): Promise<void>
  async request<T>(method: string, params?: unknown): Promise<T>
  async refreshRateLimits(): Promise<GetAccountRateLimitsResponse>
  async waitForIdle(): Promise<void>
}
```

代理的所有 App Server 通知以以下包装发给控制器，同时不改变下游消息：

```ts
this.emit("notification", {
  method: message.method!,
  params: message.params,
  sessionGeneration: this.options.sessionGeneration,
} satisfies GuardNotification)
```

`start()` 先订阅，再等待已经转发的 `initialized`；随后调用 `refreshRateLimits()`，成功发出 `rateLimits` 后才执行 `proxy.openTurnGate()`。`request()` 只调用 `proxy.request()`；客户端不得自行发送第二次 initialize。

- [ ] **步骤 4：实现 updated 去重和 pending 清理**

沿用 `AppServerManager` 的 25ms 合并语义，但计时器属于交互客户端。`stop()` 清除计时器并拒绝尚未完成的握手等待；`waitForIdle()` 等待当前刷新 promise。App Server 断开不尝试把原 TUI 迁移到新进程，而是发出 `exit` 交由会话关闭。

- [ ] **步骤 5：运行测试并提交**

运行：`npm test -- test/interactive-app-server-client.test.ts test/app-server-manager.test.ts && npm run typecheck`

预期：首次额度在门打开前完成；重复更新只主动刷新一次；现有 manager 重连测试不变。

```bash
git add tools/codex-quota-guard/src/proxy/interactive-app-server-client.ts tools/codex-quota-guard/test/interactive-app-server-client.test.ts
git commit -m "feat: 接入交互 TUI 的额度观察客户端"
```

## 任务六：让现有控制器观察交互 turn，但不改变额度状态机

**文件：**

- 修改：`tools/codex-quota-guard/src/guard/controller.ts`
- 修改：`tools/codex-quota-guard/src/guard/state-machine.ts`
- 修改：`tools/codex-quota-guard/src/persistence/state-store.ts`
- 修改：`tools/codex-quota-guard/src/ui/status.ts`
- 修改：`tools/codex-quota-guard/test/controller.test.ts`
- 修改：`tools/codex-quota-guard/test/persistence.test.ts`
- 修改：`tools/codex-quota-guard/test/ui.test.ts`
- 修改：`tools/codex-quota-guard/test/guard-state-machine.test.ts`

- [ ] **步骤 1：写 active thread、generation 和陈旧状态失败测试**

新增用例顺序：载入陈旧 active turn；用 `interactiveGeneration: "new"` 启动；发出旧 generation 通知；发出当前 `thread/started`、`turn/started`、不匹配和匹配的 `turn/completed`。关键断言：

```ts
expect(controller.status().state.activeTurn).toBeNull()
client.emit("notification", {
  method: "turn/started",
  params: { threadId: "old-thread", turn: { id: "old-turn" } },
  sessionGeneration: "old",
})
await controller.waitForIdle()
expect(controller.status().state.activeTurn).toBeNull()

client.emit("notification", {
  method: "thread/started",
  params: { thread: { id: "thread-2" } },
  sessionGeneration: "new",
})
client.emit("notification", {
  method: "turn/started",
  params: { threadId: "thread-2", turn: { id: "turn-2" } },
  sessionGeneration: "new",
})
await controller.waitForIdle()
expect(controller.status().state.activeThreadId).toBe("thread-2")
expect(controller.status().state.activeTurn).toMatchObject({
  threadId: "thread-2",
  turnId: "turn-2",
})
```

另写崩溃恢复用例：如果 `guard.state === "HANDLING"` 且事件固定 target 与 active turn 一致，新会话启动不得清除它，并仍只重试该 target。

- [ ] **步骤 2：写会话关闭精确中断失败测试**

调用新增的 `shutdownInteractiveSession()` 两次，断言 `turn/interrupt` 最多一次且参数是当时 active turn，后台 terminal clean 只使用 `activeThreadId`；weekly 低额度、quota 状态和 `HANDLED` 均不因此改变。

- [ ] **步骤 3：运行聚焦测试并确认字段和方法缺失**

运行：`npm test -- test/controller.test.ts test/persistence.test.ts test/ui.test.ts`

预期：`activeThreadId`、交互 generation 和关闭方法缺失导致失败。

- [ ] **步骤 4：增加向后兼容状态字段**

在 `PersistedGuardState` 增加：

```ts
activeThreadId: string | null
```

`createInitialState()` 设为 `null`；`StateStore.load()` 使用 `value.activeThreadId ??= value.activeTurn?.threadId ?? null` 迁移旧状态，保持 `schemaVersion: 1`。`GuardStatusOutput` 增加同名字段，JSON 直接输出；文本仍复用原 quota/guard/turns 行。

- [ ] **步骤 5：增加交互观察选项和通知处理**

控制器选项增加：

```ts
interactiveSession?: {
  generation: string
  clearUnboundActiveTurnOnStart: boolean
}
```

载入状态后、启动客户端前执行：

```ts
const fixedTarget = this.state.guard.state === "HANDLING"
  ? this.state.lastThresholdEvent?.target ?? null
  : null
if (session?.clearUnboundActiveTurnOnStart && !fixedTarget) {
  this.state.activeTurn = null
}
```

只有 `message.sessionGeneration === session.generation` 的交互通知才处理。`thread/started` 保存 `thread.id`；`turn/started` 原子保存 `activeThreadId` 和 `{threadId, turnId, startedAt}`；`turn/completed` 只有双 ID 匹配时清 active turn，但保留 active thread。阈值事件已保存的 `event.target` 永远不随新通知变化。

- [ ] **步骤 6：实现幂等会话关闭控制**

公开方法固定为：

```ts
async shutdownInteractiveSession(): Promise<void>
```

它在控制器 mutex 内快照 active turn 和 active thread；对快照 turn 至多调用一次精确 `turn/interrupt`，对该 thread 至多调用一次 `thread/backgroundTerminals/clean`，把非幂等错误写入本地 errors，清除匹配 active turn 并保存。该方法不得创建额度事件、修改 `thresholdHandled`、暂停 Goal、调用 Goal clear 或中断任何未由本会话观察的 turn。

- [ ] **步骤 7：运行全部核心回归并提交**

运行：

```bash
npm test -- test/controller.test.ts test/guard-state-machine.test.ts test/persistence.test.ts test/ui.test.ts
npm run typecheck
```

预期：新增交互跟踪通过；原有 primary/secondary 300 分钟、weekly-only、窗口消失/返回、同 key HANDLED、新 key ARMED、stale low 和固定 target 测试全部不变。

```bash
git add tools/codex-quota-guard/src/guard/controller.ts tools/codex-quota-guard/src/guard/state-machine.ts tools/codex-quota-guard/src/persistence/state-store.ts tools/codex-quota-guard/src/ui/status.ts tools/codex-quota-guard/test/controller.test.ts tools/codex-quota-guard/test/guard-state-machine.test.ts tools/codex-quota-guard/test/persistence.test.ts tools/codex-quota-guard/test/ui.test.ts
git commit -m "feat: 跟踪交互会话的精确 thread 和 turn"
```

## 任务七：实现预检、原生 TUI 启动和幂等会话生命周期

**文件：**

- 新建：`tools/codex-quota-guard/src/interactive/preflight.ts`
- 新建：`tools/codex-quota-guard/src/interactive/tui-process.ts`
- 新建：`tools/codex-quota-guard/src/interactive/session.ts`
- 新建：`tools/codex-quota-guard/test/interactive-session.test.ts`

- [ ] **步骤 1：写预检默认放行和严格拒绝失败测试**

用 fake controller 分别返回 ARMED、DORMANT、awaiting baseline：

```ts
it.each([
  [{ state: "DORMANT", available: false, awaiting: false }, false, true],
  [{ state: "DORMANT", available: false, awaiting: false }, true, false],
  [{ state: "ARMED", available: true, awaiting: true }, true, false],
  [{ state: "ARMED", available: true, awaiting: false }, true, true],
])("按严格配置决定是否创建 TUI", async (quota, strict, allowed) => {
  const result = runInteractivePreflight(fakeController(quota), {
    requireProtection: strict,
    now: 1,
  })
  if (allowed) await expect(result).resolves.toBeDefined()
  else await expect(result).rejects.toThrow(/5 小时保护/)
})
```

断言所有拒绝都发生在 `spawnTui` 前；DORMANT 输出 weekly、`guard: DORMANT`、`turns: ALLOWED`，不使用 weekly 代替保护窗口。

ARMED 启动文本必须包含 `Codex Quota Guard: active`、真实绝对路径、`quota: SAFE|WARNING|LOW|CRITICAL|UNKNOWN`、`guard: ARMED|HANDLING|HANDLED|DORMANT|UNKNOWN`、`turns: ALLOWED|WAITING|BLOCKED`、`weekly: ... informational only` 和 `Bypass: codex-raw`。`CRITICAL + HANDLED` 必须仍同时显示 `turns: ALLOWED`，不得出现全局 `STOPPED`。

- [ ] **步骤 2：写启动顺序、token 环境和清理失败测试**

使用记录调用顺序的 fake 组件，断言：

```ts
expect(order).toEqual([
  "preflight:start",
  "preflight:stop",
  "raw:start",
  "token:create",
  "endpoint:start",
  "proxy:start",
  "controller:start",
  "tui:start",
  "controller:ready",
  "proxy:stop",
  "controller:shutdown",
  "controller:stop",
  "endpoint:close-client",
  "tui:stop",
  "raw:stop",
  "endpoint:stop",
])
expect(rawEnvironment).not.toHaveProperty("CODEX_QUOTA_GUARD_REMOTE_TOKEN")
expect(tuiEnvironment.CODEX_QUOTA_GUARD_REMOTE_TOKEN).toBe(token)
expect(tuiArguments).toContain("--remote-auth-token-env")
expect(tuiArguments).not.toContain(token)
```

分别模拟正常退出、Ctrl-C、终端关闭、TUI 崩溃、App Server 崩溃和代理异常；每个组件 stop 计数为 1，socket/临时目录不存在，返回码保留 TUI code 或明确非零失败码。把 token 和假 prompt/output/approval 哨兵注入事件后，断言 stdout、stderr、`.codex-guard/state.json` 和报告均不包含这些内容。

- [ ] **步骤 3：运行测试并确认模块缺失**

运行：`npm test -- test/interactive-session.test.ts`

预期：三个交互模块不存在导致失败。

- [ ] **步骤 4：实现短生命周期预检**

公开接口：

```ts
export interface InteractivePreflightOptions {
  requireProtection: boolean
  runtimeContext: RuntimeContext
  now?: () => number
}

export interface InteractivePreflightResult {
  status: GuardStatusOutput
  text: string
}

export async function runInteractivePreflight(
  controller: GuardController,
  options: InteractivePreflightOptions,
): Promise<InteractivePreflightResult>
```

函数 `start()` 控制器、取得并格式化状态、在现有 `formatStatusText` 周围增加简短工具/可执行文件/weekly informational/bypass 标题、按 `protectedWindow.available` 和 `awaitingBaseline` 应用严格准入，并在 `finally` 中 `stop()`。它不得调用 `thread/start`、`turn/start` 或生成模型总结。

- [ ] **步骤 5：实现原生 TUI 子进程**

`TuiProcess` 只接受已经验证的绝对路径：

```ts
export interface TuiProcessOptions {
  executable: string
  remoteAddress: string
  tokenEnvironmentName: string
  token: string
  tuiArgs: string[]
  environment?: NodeJS.ProcessEnv
}
```

spawn 参数固定为：

```ts
[
  "--remote",
  options.remoteAddress,
  "--remote-auth-token-env",
  options.tokenEnvironmentName,
  ...options.tuiArgs,
]
```

使用 `stdio: "inherit"` 和 `windowsHide: true`；只在 TUI 子进程 env 加入 token。提供 `start()`、`waitForExit()`、幂等 `stop()`，温和终止超时后才强制结束。

- [ ] **步骤 6：实现 InteractiveSession 的唯一清理路径**

会话公开接口：

```ts
export interface InteractiveRunOptions {
  tuiArgs: string[]
  requireProtection: boolean
}

export class InteractiveSession {
  async run(options: InteractiveRunOptions): Promise<number>
  async stop(reason: string): Promise<void>
}
```

`run()` 严格按测试顺序创建组件，并对 TUI exit、raw exit、endpoint close、代理 error 和进程信号执行 `Promise.race`。控制器先调用 `start()` 并订阅握手，保留其尚未完成的 promise，再启动 TUI，最后等待 controller ready，避免漏掉极快的 initialized。`stop()` 用单一 promise 去重，先停止代理接收消息，再调用控制器精确关闭、停止客户端与控制器、关闭当前 TUI WebSocket、终止 TUI、停止上游、关闭 endpoint server，删除临时资源，清空 token 引用和 ID map，最后移除信号监听器。App Server 已退出时记录“未确认中断”，不得伪造成功。

- [ ] **步骤 7：运行生命周期测试并提交**

运行：`npm test -- test/interactive-session.test.ts test/controller.test.ts && npm run typecheck`

预期：所有退出路径清理一次；没有真实 Codex 进程、模型 turn 或 token 文件。

```bash
git add tools/codex-quota-guard/src/interactive tools/codex-quota-guard/test/interactive-session.test.ts
git commit -m "feat: 编排受保护的原生 Codex 交互会话"
```

## 任务八：接入 `interactive` 命令和原生 TUI 参数边界

**文件：**

- 修改：`tools/codex-quota-guard/src/cli-args.ts`
- 修改：`tools/codex-quota-guard/src/cli-runtime.ts`
- 修改：`tools/codex-quota-guard/src/cli.ts`
- 新建：`tools/codex-quota-guard/src/runtime/remote-capabilities.ts`
- 修改：`tools/codex-quota-guard/src/runtime/runtime-context.ts`
- 修改：`tools/codex-quota-guard/src/runtime/types.ts`
- 修改：`tools/codex-quota-guard/src/doctor.ts`
- 新建：`tools/codex-quota-guard/test/remote-capabilities.test.ts`
- 修改：`tools/codex-quota-guard/test/runtime-context.test.ts`
- 修改：`tools/codex-quota-guard/test/doctor.test.ts`
- 修改：`tools/codex-quota-guard/test/cli-args.test.ts`
- 修改：`tools/codex-quota-guard/test/cli-runtime.test.ts`

- [ ] **步骤 1：写同一二进制 remote help 能力失败测试**

用当前两类 help 文本夹具断言：

```ts
expect(inspectRemoteCapabilities({
  tuiHelp: "--remote <ADDR> ... ws://IP:PORT ... unix://PATH\n--remote-auth-token-env <ENV_VAR>",
  appServerHelp: "--listen <URI> ... stdio:// ... unix://PATH ... ws://IP:PORT",
})).toEqual({
  remoteTui: true,
  remoteAuthTokenEnv: true,
  remoteUnixSocket: true,
  remoteLoopbackWebSocket: true,
  appServerStdio: true,
})
```

缺少任一字符串时对应能力为 false。`createRuntimeContext` 必须对已经选择的同一真实绝对路径分别运行 `--help` 和 `app-server --help`，每次 interactive 调用都重新生成 schema 和 help 证据；路径或版本变化不得复用旧结果。

- [ ] **步骤 2：写无提示 interactive 和 `--` 分界失败测试**

解析断言：

```ts
expect(parseCliArgs(["interactive"])).toEqual({
  command: "interactive",
  codexPath: undefined,
  requireProtection: false,
  tuiArgs: [],
})
expect(parseCliArgs([
  "interactive",
  "--require-protection",
  "--codex-path",
  "/real/codex",
  "--",
  "--model",
  "gpt-5",
])).toEqual({
  command: "interactive",
  codexPath: "/real/codex",
  requireProtection: true,
  tuiArgs: ["--model", "gpt-5"],
})
```

`interactive` 后任何位置出现 `--remote`、`--remote=...`、`--remote-auth-token-env` 或同名等号形式都必须报错；位置提示词没有放在 `--` 后时也报错，不得隐式当任务。

- [ ] **步骤 3：写运行时锁、退出码和严格配置失败测试**

为 `CliDependencies` 注入 `createInteractiveSession`，断言运行上下文只构造一次、进程锁覆盖整个 session、TUI 退出码原样返回、异常仍释放锁。`interactive` 不调用现有 `controller.run()` 或 `resume()`。任意平台缺 `remoteLoopbackWebSocket`、`remoteTui`、`remoteAuthTokenEnv` 或 `appServerStdio` 时，都在 shell 安装/TUI spawn 前拒绝并说明不接管默认 `codex`。`remoteUnixSocket` 仍作为协议诊断信息显示，但不是带 token 交互路径的准入条件。

- [ ] **步骤 4：运行能力和 CLI 测试并确认缺失**

运行：`npm test -- test/remote-capabilities.test.ts test/runtime-context.test.ts test/doctor.test.ts test/cli-args.test.ts test/cli-runtime.test.ts`

预期：remote 能力类型/探测不存在，且 `interactive` 当前被报为未知命令。

- [ ] **步骤 5：实现并接入 remote 能力证据**

新增类型：

```ts
export interface RemoteCapabilities {
  remoteTui: boolean
  remoteAuthTokenEnv: boolean
  remoteUnixSocket: boolean
  remoteLoopbackWebSocket: boolean
  appServerStdio: boolean
}
```

`RuntimeContext` 增加 `remoteCapabilities`。runtime-context 使用 `execFile` 对同一 `codexExecutableRealPath` 读取两个 help 输出，并与现场 schema 一起构造上下文。doctor 文本/JSON逐项显示这些证据；候选但未选择的路径全部为 false，不执行 help。交互准入按当前平台检查，缺失时错误包含具体缺项和安全退化说明，不启动代理、不安装 shim。

- [ ] **步骤 6：扩展解析联合类型**

增加：

```ts
| {
    command: "interactive"
    codexPath: string | undefined
    requireProtection: boolean
    tuiArgs: string[]
  }
```

解析器先用 `args.indexOf("--")` 分离 Guard 参数和 TUI 参数；只有 interactive 接受分界后的参数。Guard 选项仍只有 `--codex-path` 与 `--require-protection`，远程连接参数由 Guard 独占。

- [ ] **步骤 7：扩展 CLI 依赖与执行分支**

在 `CliDependencies` 增加：

```ts
createInteractiveSession(context: RuntimeContext): InteractiveSession
```

`executeCli` 对 interactive：构造一次 context、执行 `assertLaunchAllowed`、取得同一项目锁、调用 `session.run({tuiArgs, requireProtection})`，在 `finally` 调用 `session.stop("cli-finally")` 和释放锁。帮助文本明确任务提示在 TUI 内输入。

- [ ] **步骤 8：在真实依赖装配中复用现有组件**

`src/cli.ts` 的 preflight controller 继续用 `AppServerManager + ProcessAppServerConnection`；主会话使用 `RawAppServerProcess + LocalTuiEndpoint + TransparentJsonRpcProxy + InteractiveAppServerClient + GuardController`。两个控制器共享同一 `StateStore` 和 `LocalThresholdReporter`，主控制器传入唯一 session generation。

- [ ] **步骤 9：运行能力、CLI、帮助和回归测试并提交**

运行：`npm test -- test/remote-capabilities.test.ts test/runtime-context.test.ts test/doctor.test.ts test/cli-args.test.ts test/cli-runtime.test.ts test/controller.test.ts && npm run typecheck`

预期：`interactive` 无提示可执行；严格拒绝发生在 TUI 前；原有 status/run/resume/doctor 参数完全通过。

```bash
git add tools/codex-quota-guard/src/runtime tools/codex-quota-guard/src/doctor.ts tools/codex-quota-guard/src/cli-args.ts tools/codex-quota-guard/src/cli-runtime.ts tools/codex-quota-guard/src/cli.ts tools/codex-quota-guard/test/remote-capabilities.test.ts tools/codex-quota-guard/test/runtime-context.test.ts tools/codex-quota-guard/test/doctor.test.ts tools/codex-quota-guard/test/cli-args.test.ts tools/codex-quota-guard/test/cli-runtime.test.ts
git commit -m "feat: 增加 guarded interactive 命令"
```

## 任务九：增加原子全局配置和 `config` 命令

**文件：**

- 新建：`tools/codex-quota-guard/src/persistence/global-config-store.ts`
- 新建：`tools/codex-quota-guard/test/global-config-store.test.ts`
- 修改：`tools/codex-quota-guard/src/cli-args.ts`
- 修改：`tools/codex-quota-guard/src/cli-runtime.ts`
- 修改：`tools/codex-quota-guard/src/cli.ts`
- 修改：`tools/codex-quota-guard/test/cli-args.test.ts`
- 修改：`tools/codex-quota-guard/test/cli-runtime.test.ts`

- [ ] **步骤 1：写默认值、平台路径、权限和原子失败测试**

分别注入 `darwin`、`linux`、`win32` 与临时 HOME/LOCALAPPDATA，断言默认配置：

```ts
expect(await store.load()).toEqual({
  defaultInteractiveProtection: true,
  defaultRequireProtection: false,
  realCodexExecutable: null,
  realCodexVersion: null,
  shellIntegration: {
    enabled: false,
    shimDirectory: null,
    installedAt: null,
    shells: [],
  },
})
```

保存两次后无 `.tmp-` 文件；Unix 目录 `0700`、文件 `0600`。向输入对象注入 `accessToken`、`cookie` 和未知字段，最终文件不得包含它们。

- [ ] **步骤 2：写 config 命令失败测试**

覆盖：

```text
codex-quota-guard config show
codex-quota-guard config show --json
codex-quota-guard config set default-require-protection true
codex-quota-guard config set default-require-protection false
```

其他键和值必须失败。`config show` 合并展示全局值、当前项目 `codexPath` 及来源，但不得解析或修改 `~/.codex/config.toml`，也不得启动 App Server。

再写运行时测试：全局 `defaultRequireProtection: true` 且命令未传 flag 时，interactive session 收到 `requireProtection: true`；全局为 false 但显式 `--require-protection` 时仍为 true。两者通过逻辑 OR 合并，不提供 CLI 反向覆盖。

- [ ] **步骤 3：运行测试并确认配置模块和命令缺失**

运行：`npm test -- test/global-config-store.test.ts test/cli-args.test.ts test/cli-runtime.test.ts`

预期：新模块或命令不存在导致失败。

- [ ] **步骤 4：实现配置类型、路径和原子保存**

类型固定为：

```ts
export type SupportedShell = "zsh" | "bash" | "powershell"

export interface GlobalGuardConfig {
  defaultInteractiveProtection: boolean
  defaultRequireProtection: boolean
  realCodexExecutable: string | null
  realCodexVersion: string | null
  shellIntegration: {
    enabled: boolean
    shimDirectory: string | null
    installedAt: string | null
    shells: Array<{ shell: SupportedShell; profilePath: string }>
  }
}
```

macOS/Linux 路径为 `<home>/.local/share/codex-quota-guard/config.json`，Windows 为 `<LOCALAPPDATA>/codex-quota-guard/config.json`。实现 `load()`、`save()`、`update(mutator)`；写入临时文件、sync、rename，保存前只从白名单字段重建对象。

- [ ] **步骤 5：接入 config 解析和执行**

解析联合类型增加：

```ts
| { command: "config"; operation: "show"; json: boolean }
| {
    command: "config"
    operation: "set-default-require-protection"
    value: boolean
  }
```

config 分支必须在 `resolveRuntimeContext` 和 `acquireLock` 之前执行。interactive 执行分支使用 `parsed.requireProtection || global.defaultRequireProtection`。`defaultInteractiveProtection` 首版不提供 set；若手工文件为 false，后续 shim 路由显式拒绝，绝不自动旁路。

- [ ] **步骤 6：运行配置、CLI 和安全测试并提交**

运行：

```bash
npm test -- test/global-config-store.test.ts test/config-store.test.ts test/cli-args.test.ts test/cli-runtime.test.ts test/persistence.test.ts
npm run typecheck
```

预期：全局配置与项目配置互不覆盖；无认证字段；config 命令零 App Server 调用。

```bash
git add tools/codex-quota-guard/src/persistence/global-config-store.ts tools/codex-quota-guard/src/cli-args.ts tools/codex-quota-guard/src/cli-runtime.ts tools/codex-quota-guard/src/cli.ts tools/codex-quota-guard/test/global-config-store.test.ts tools/codex-quota-guard/test/cli-args.test.ts tools/codex-quota-guard/test/cli-runtime.test.ts
git commit -m "feat: 增加默认终端集成的全局配置"
```

## 任务十：实现仅当前 shell 的可逆 shim 安装事务

**文件：**

- 新建：`tools/codex-quota-guard/src/shell/current-shell.ts`
- 新建：`tools/codex-quota-guard/src/shell/profile-block.ts`
- 新建：`tools/codex-quota-guard/src/shell/shim-template.ts`
- 新建：`tools/codex-quota-guard/src/shell/installer.ts`
- 新建：`tools/codex-quota-guard/test/current-shell.test.ts`
- 新建：`tools/codex-quota-guard/test/profile-block.test.ts`
- 新建：`tools/codex-quota-guard/test/shell-installer.test.ts`
- 修改：`tools/codex-quota-guard/src/cli-args.ts`
- 修改：`tools/codex-quota-guard/src/cli-runtime.ts`
- 修改：`tools/codex-quota-guard/src/cli.ts`
- 修改：`tools/codex-quota-guard/test/cli-args.test.ts`
- 修改：`tools/codex-quota-guard/test/cli-runtime.test.ts`

- [ ] **步骤 1：写当前 shell 与 profile 选择失败测试**

覆盖矩阵固定为：

```ts
it.each([
  ["darwin", "/bin/zsh", "zsh", ".zshrc"],
  ["darwin", "/bin/bash", "bash", ".bash_profile"],
  ["linux", "/usr/bin/zsh", "zsh", ".zshrc"],
  ["linux", "/bin/bash", "bash", ".bashrc"],
])("只选择当前 Unix shell", async (platform, shellPath, shell, profile) => {
  expect(await detectCurrentShell({ platform, shellPath, home: "/home/me" }))
    .toEqual({ shell, profilePath: `/home/me/${profile}` })
})
```

Windows 通过依赖注入的父进程名 `pwsh.exe` 或 `powershell.exe` 和 `$PROFILE.CurrentUserCurrentHost` 查询结果选择 PowerShell；`cmd.exe`、fish、空 `$SHELL`、父进程与 `$SHELL` 冲突且无法证明当前 shell 时拒绝，不修改任何文件。

- [ ] **步骤 2：写 profile 标记块的完整性测试**

标记固定为：

```text
# >>> codex-quota-guard shell integration >>>
export PATH='<shim-directory>':"$PATH"
# <<< codex-quota-guard shell integration <<<
```

PowerShell 中间行为为 `$env:PATH = '<shim-directory>;' + $env:PATH`。测试覆盖：无块时追加一次、完整同块幂等、只有开始/结束标记拒绝、多块拒绝、块内容被改写拒绝、卸载只删除完整匹配块并保留前后用户内容。

- [ ] **步骤 3：写 shim 所有权、空格路径和递归拒绝测试**

使用包含空格的 Node 与 CLI 路径生成 POSIX 和 `.cmd` shim。断言内容带：

```text
codex-quota-guard-shim
format=1
entry=codex 或 entry=codex-raw
checksum=<sha256>
```

解析器必须验证 checksum 和完整期望内容。目标不存在可安装；完全匹配视为幂等；任意未知文件、用户改写或保存的真实 Codex 指向 shim/Guard 自身时拒绝。

- [ ] **步骤 4：写 install/status/uninstall 事务失败测试**

在临时 HOME 中用 fake runner 覆盖：

- install 显示真实 Codex、两个 shim、全局配置和当前 profile 的绝对路径；
- TTY 输入必须完全匹配 `INSTALL`，其他输入取消；非 TTY 拒绝；
- 只修改当前 shell profile，另一个 `.bashrc`/`.zshrc` 哈希不变；
- install 两次幂等；
- 写 profile、写 config 或新 shell 解析验证任一步失败时恢复原 profile、shim 和 config；
- status 检查所有权、checksum、保存路径、版本和 PATH 顺序，但不写文件；
- uninstall 输入 `UNINSTALL` 后只移除当前 shell 完整块；
- 若配置还有其他 shell 记录，保留共享 shim；最后一个 shell 卸载才删除匹配 shim 和空目录；
- uninstall 两次返回“已卸载”；用户修改过的 shim 或标记块保留并报冲突；
- `~/.codex/config.toml` 前后哈希不变。

- [ ] **步骤 5：运行 shell 单元测试并确认模块缺失**

运行：`npm test -- test/current-shell.test.ts test/profile-block.test.ts test/shell-installer.test.ts`

预期：新模块不存在导致失败。

- [ ] **步骤 6：实现当前 shell 检测和 profile 纯函数**

公开类型：

```ts
export interface CurrentShell {
  shell: SupportedShell
  profilePath: string
}

export interface ProfileInspection {
  status: "absent" | "managed" | "partial" | "duplicate" | "modified"
  content: string
}
```

Unix 优先核对直接父 shell basename，再用 `$SHELL` 作为一致性证据；Windows 只接受已证明的 `pwsh.exe`/`powershell.exe` 父进程，并通过对应程序读取 `CurrentUserCurrentHost`。所有 profile 操作先由纯函数检查，再由 installer 原子写入。

- [ ] **步骤 7：实现可校验 shim 模板**

POSIX payload 采用单引号安全转义，核心执行行为为：

```sh
exec '<node-absolute-path>' '<cli-entry-absolute-path>' __shim codex "$@"
```

`codex-raw` 使用 `__shim codex-raw`。Windows `.cmd` 使用带双引号的绝对路径和 `%*`。checksum 对除 checksum 行外的规范化 UTF-8 payload 计算 SHA-256；验证时重建期望 payload 并常量比较散列。

- [ ] **步骤 8：实现 install/status/uninstall 事务**

公开接口：

```ts
export interface ShellInstallerOptions {
  rootDirectory: string
  globalStore: GlobalConfigStore
  nodeExecutable: string
  cliEntry: string
}

export class ShellInstaller {
  install(context: RuntimeContext): Promise<ShellOperationResult>
  status(): Promise<ShellOperationResult>
  uninstall(): Promise<ShellOperationResult>
}
```

install 在任何写入前完成冲突检查、打印影响范围和 TTY 确认；然后保存 profile/config/shim 的原始快照，原子写两个 shim、唯一 profile 块和全局配置，最后启动当前 shell 的隔离命令验证 `codex` 解析到 shim 且内部身份检查返回保存的真实绝对路径。失败时按反向顺序恢复快照。卸载使用相同事务机制，绝不删除不匹配的用户文件。

install 还必须调用任务八的当前平台 remote 能力断言；缺少安全透明代理所需能力时，在任何写入和确认前拒绝，不接管默认 `codex`。

- [ ] **步骤 9：接入 shell 命令解析与零写 status**

新增解析形状：

```ts
| {
    command: "shell"
    operation: "install"
    codexPath: string | undefined
  }
| { command: "shell"; operation: "status"; json: boolean }
| { command: "shell"; operation: "uninstall" }
```

install 才解析 RuntimeContext 并保存 resolver 选择的真实路径和版本；status/uninstall 读取全局配置，不启动 App Server。非交互 status 允许，install/uninstall 非 TTY 拒绝。

- [ ] **步骤 10：运行事务、CLI 和跨平台测试并提交**

运行：

```bash
npm test -- test/current-shell.test.ts test/profile-block.test.ts test/shell-installer.test.ts test/cli-args.test.ts test/cli-runtime.test.ts
npm run typecheck
```

预期：zsh、bash、PowerShell 分支、当前 shell 限定、空格路径、冲突、回滚和幂等全部通过。

```bash
git add tools/codex-quota-guard/src/shell tools/codex-quota-guard/src/cli-args.ts tools/codex-quota-guard/src/cli-runtime.ts tools/codex-quota-guard/src/cli.ts tools/codex-quota-guard/test/current-shell.test.ts tools/codex-quota-guard/test/profile-block.test.ts tools/codex-quota-guard/test/shell-installer.test.ts tools/codex-quota-guard/test/cli-args.test.ts tools/codex-quota-guard/test/cli-runtime.test.ts
git commit -m "feat: 增加当前 shell 的可逆默认 Codex shim"
```

## 任务十一：实现 wrapper 路由、原始旁路和精确子进程退出语义

**文件：**

- 新建：`tools/codex-quota-guard/src/process/run-child.ts`
- 新建：`tools/codex-quota-guard/src/shell/router.ts`
- 新建：`tools/codex-quota-guard/test/shell-router.test.ts`
- 修改：`tools/codex-quota-guard/src/cli-args.ts`
- 修改：`tools/codex-quota-guard/src/cli-runtime.ts`
- 修改：`tools/codex-quota-guard/src/cli.ts`
- 修改：`tools/codex-quota-guard/test/cli-args.test.ts`
- 修改：`tools/codex-quota-guard/test/cli-runtime.test.ts`
- 修改：`tools/codex-quota-guard/test/shell-installer.test.ts`

- [ ] **步骤 1：写纯路由表失败测试**

路由断言必须逐项覆盖：

```ts
expect(routeShim("codex", [], env())).toEqual({ kind: "interactive", tuiArgs: [] })
expect(routeShim("codex", ["--model", "gpt-5"], env()))
  .toEqual({ kind: "interactive", tuiArgs: ["--model", "gpt-5"] })
expect(routeShim("codex", ["raw", "exec", "x"], env()))
  .toEqual({ kind: "raw", args: ["exec", "x"], reason: "explicit-raw" })
expect(routeShim("codex-raw", ["--version"], env()))
  .toEqual({ kind: "raw", args: ["--version"], reason: "codex-raw" })
expect(routeShim("codex", ["login"], env())).toMatchObject({ kind: "management" })
expect(routeShim("codex", ["exec", "x"], env())).toMatchObject({ kind: "reject-exec" })
expect(routeShim("codex", ["--version"], env())).toEqual({ kind: "version" })
expect(routeShim("codex", ["future-command"], env())).toMatchObject({ kind: "unknown" })
```

`CODEX_QUOTA_GUARD_BYPASS=1` 只把当前调用变为 raw，不修改输入环境对象或配置。用户传入 remote 参数时，interactive 路由必须拒绝。

- [ ] **步骤 2：写保存路径、警告和退出码失败测试**

用 fake child runner 断言 raw、BYPASS 和管理命令始终执行全局配置中的真实绝对路径，不查 PATH；路径丢失、变成 shim、不可执行或 resolver 验证失败时拒绝并提示 doctor。路径含空格时参数数组保持边界。

另模拟保存路径未变但 `--version` 输出升级：`shell status` 显示版本漂移；下一次 guarded interactive 必须用该同一绝对路径重新执行 help 与 schema 探测，成功后原子更新 `realCodexVersion`，remote 能力缺失则拒绝且保留原配置。raw 与管理命令继续执行用户明确保存的路径，不因版本字符串变化查找另一份 Codex。

TTY raw 在 stderr 显示醒目未保护警告；stdin/stderr 非 TTY 时不污染 stdout。管理命令只输出一行说明。子进程退出 `37` 时 wrapper 返回 `37`；信号退出按平台映射成非零，不伪装成功。

- [ ] **步骤 3：写版本、exec 和未知命令失败测试**

`codex --version` 文本必须同时含 wrapper `0.3.0`、真实绝对路径和保存/实测版本；`codex-raw --version` stdout 与 fake 原始输出完全一致。`codex exec` 返回非零并同时提示 `codex-quota-guard run` 与 `codex-raw exec`。未知命令在非 TTY 直接失败；TTY 只有用户明确输入 `raw` 才旁路，空输入或 `cancel` 取消，不自动当提示词。

- [ ] **步骤 4：运行路由测试并确认模块缺失**

运行：`npm test -- test/shell-router.test.ts`

预期：router 和 child runner 不存在导致失败。

- [ ] **步骤 5：实现纯路由联合类型**

```ts
export type ShimRoute =
  | { kind: "interactive"; tuiArgs: string[] }
  | { kind: "raw"; args: string[]; reason: "codex-raw" | "explicit-raw" | "bypass" }
  | { kind: "management"; args: string[] }
  | { kind: "version" }
  | { kind: "reject-exec" }
  | { kind: "unknown"; args: string[] }
  | { kind: "reject"; message: string }
```

管理 allowlist 固定包含 `login`、`logout`、`mcp`、`app-server`、`completion`、`plugin`、`mcp-server`、`remote-control`、`update`、`doctor` 和 `features`。新版本未知子命令不加入默认旁路。

- [ ] **步骤 6：实现精确子进程 runner 与 dispatch**

`runExactChild(executable, args, options)` 只用 `spawn(executable, args, {stdio: "inherit", windowsHide: true})`，不通过 shell，返回真实 exit code。dispatch 在任何分支前加载并验证 `realCodexExecutable`，确认 realpath 不等于 `codex` shim、`codex-raw` shim、Node CLI entry 或 Guard 可执行入口。

当 `defaultInteractiveProtection === false` 时，无参数 `codex` 显式拒绝并提示 `codex-raw`，不得静默 raw。guarded interactive 通过同一进程回调现有 `executeCli(["interactive", "--codex-path", saved, "--", ...tuiArgs])`，不 spawn 第二个 Guard wrapper。

- [ ] **步骤 7：接入隐藏 shim dispatch**

解析器只为工具生成的 shim 接受：

```text
codex-quota-guard __shim codex ...
codex-quota-guard __shim codex-raw ...
```

帮助不宣传该内部命令。`ShellInstaller` 的身份验证调用 `__shim identity`，返回保存路径但不启动 TUI。所有 raw/管理分支都不取得项目控制器锁、不读取额度、不修改 HANDLED 记录。

- [ ] **步骤 8：运行路由、shim、CLI 和 resolver 回归并提交**

运行：

```bash
npm test -- test/shell-router.test.ts test/shell-installer.test.ts test/cli-args.test.ts test/cli-runtime.test.ts test/executable-resolver.test.ts
npm run typecheck
```

预期：无参数、交互参数、raw、BYPASS、管理、exec、版本、未知命令、递归和退出码全部通过。

```bash
git add tools/codex-quota-guard/src/process/run-child.ts tools/codex-quota-guard/src/shell/router.ts tools/codex-quota-guard/src/shell/installer.ts tools/codex-quota-guard/src/cli-args.ts tools/codex-quota-guard/src/cli-runtime.ts tools/codex-quota-guard/src/cli.ts tools/codex-quota-guard/test/shell-router.test.ts tools/codex-quota-guard/test/shell-installer.test.ts tools/codex-quota-guard/test/cli-args.test.ts tools/codex-quota-guard/test/cli-runtime.test.ts
git commit -m "feat: 路由默认 Codex、管理命令和原始旁路"
```

## 任务十二：增加真实传输但零模型的 fake TUI 端到端测试

**文件：**

- 新建：`tools/codex-quota-guard/test/fakes/fake-remote-tui.mjs`
- 新建：`tools/codex-quota-guard/test/fakes/fake-codex.mjs`
- 新建：`tools/codex-quota-guard/test/interactive-e2e.test.ts`
- 修改：`tools/codex-quota-guard/test/fakes/fake-jsonl-app-server.mjs`
- 修改：`tools/codex-quota-guard/test/interactive-session.test.ts`

- [ ] **步骤 1：定义 fake transcript 和两种额度场景**

fake App Server 从环境变量读取 transcript 路径和场景：

```ts
type Scenario = "edge" | "weekly-only" | "app-server-crash"
```

`edge` 初次 `account/rateLimits/read` 返回 5 小时 90% used 与 weekly；第一个 turn 已开始后发出 `account/rateLimits/updated`，后续 read 返回相同 windowKey 的 98.5% used。`weekly-only` 始终只有 weekly 99% used。所有请求、响应、通知、审批响应和退出原因追加为 JSONL transcript，内容不含 token、提示词或模型输出。

- [ ] **步骤 2：实现 fake TUI 协议脚本**

fake TUI 解析 Guard 注入的 `--remote` 和 `--remote-auth-token-env`，从指定环境变量取 token，建立真实本地 WebSocket，依次：

```text
initialize → initialized → thread/start → turn/start(first)
响应 App Server 审批 server request
等待 first turn interrupted
turn/start(second)
确认 second turn started 后主动退出
```

脚本还记录收到的未知通知和扩展字段；不得创建任何真实模型输入。

- [ ] **步骤 3：写完整边沿端到端失败测试**

通过 `process.execPath + fake-codex.mjs` 走真实 stdio、WebSocket、代理和控制器：

```ts
it("只中断边沿瞬间的 first turn 且 HANDLED 后放行 second turn", async () => {
  const result = await runFakeInteractive("edge")
  expect(result.interrupts).toEqual([{ threadId: "thread-1", turnId: "turn-1" }])
  expect(result.turnStarts).toEqual(["turn-1", "turn-2"])
  expect(result.state.guard.state).toBe("HANDLED")
  expect(result.state.activeTurn?.turnId ?? null).not.toBe("turn-1")
  expect(result.approvalRoundTrips).toBe(1)
  expect(result.unknownNotificationPreserved).toBe(true)
})
```

额度事件后再发一次相同 updated，断言没有第二次 interrupt；旧事件不得指向 `turn-2`。

同时断言 Guard 状态、报告和公开输出不包含 fake prompt、模型输出、审批决定或 capability token；上游 transcript 中没有 `config/write`、`config/value/write`、`config/batchWrite` 等 Guard 主动配置写请求。

- [ ] **步骤 4：写 weekly-only、断线和资源清理端到端测试**

`weekly-only` 断言 `interrupts=[]`、`guard=DORMANT`、`turns=ALLOWED`、weekly 可见。`app-server-crash` 断言 TUI 被关闭、状态保存错误、会话非零退出且无重连到新进程。另在 session 单元测试触发 Ctrl-C，断言 loopback 监听、token 文件、App Server 和 TUI 子进程均不存在。

- [ ] **步骤 5：运行端到端测试并确认 fake 流程失败**

运行：`npm test -- test/interactive-e2e.test.ts test/interactive-session.test.ts`

预期：在 fake 脚本或会话装配完成前失败；进程列表中不出现真实 Codex 路径。

- [ ] **步骤 6：完成 fake 协议并修复发现的真实竞态**

只根据失败证据调整代理、会话或交互通知入口。允许的修复范围是消息顺序、ID 映射、generation、幂等 cleanup 和门控；不得改变额度阈值、用 weekly 触发或给 `HANDLED` 增加停止 latch。任何竞态先增加可重复失败断言，再写最小修复。

- [ ] **步骤 7：运行所有代理与控制器测试并提交**

运行：

```bash
npm test -- test/raw-app-server-process.test.ts test/transparent-proxy.test.ts test/local-tui-endpoint.test.ts test/interactive-app-server-client.test.ts test/interactive-session.test.ts test/interactive-e2e.test.ts test/controller.test.ts test/guard-state-machine.test.ts
npm run typecheck
```

预期：全程只使用 fake；edge 只中断 first turn 一次；second turn、weekly-only、审批、未知协议和资源清理全部通过。

```bash
git add tools/codex-quota-guard/test/fakes tools/codex-quota-guard/test/interactive-e2e.test.ts tools/codex-quota-guard/test/interactive-session.test.ts tools/codex-quota-guard/src
git commit -m "test: 覆盖默认终端代理的 fake 端到端流程"
```

## 任务十三：更新版本、用户文档、发布清单和三平台 CI

**文件：**

- 修改：`tools/codex-quota-guard/package.json`
- 修改：`tools/codex-quota-guard/package-lock.json`
- 修改：`tools/codex-quota-guard/README.md`
- 修改：`tools/codex-quota-guard/CHANGELOG.md`
- 修改：`tools/codex-quota-guard/RELEASE_CHECKLIST.md`
- 修改：`.github/workflows/codex-quota-guard.yml`
- 修改：`tools/codex-quota-guard/test/cli-runtime.test.ts`

- [ ] **步骤 1：写帮助和包元数据失败断言**

帮助测试要求出现：

```text
codex-quota-guard interactive
codex-quota-guard shell install|status|uninstall
codex-quota-guard config show
codex-quota-guard config set default-require-protection true|false
任务提示在原生 TUI 内输入
旁路：codex-raw
```

包测试读取 `package.json`，断言版本 `0.3.0`、`dependencies.ws` 存在、bin 仍只发布 `codex-quota-guard`；`codex` 与 `codex-raw` 由用户确认后生成，不在 npm 安装时静默创建。

- [ ] **步骤 2：运行帮助与包测试并确认版本失败**

运行：`npm test -- test/cli-runtime.test.ts && npm pack --dry-run`

预期：帮助或版本仍为旧值而失败；dry-run 不运行模型。

- [ ] **步骤 3：升级版本并锁定依赖**

把独立包版本改为 `0.3.0`，同步 lockfile 根 package 版本和依赖树。运行：

```bash
npm install --package-lock-only --ignore-scripts --cache /private/tmp/codex-quota-guard-npm-cache
```

预期：根仓库 package 文件无变化。

- [ ] **步骤 4：完整更新 README**

README 必须包含：默认 `codex` 只是终端 shim、不会修改真实二进制或 `~/.codex/config.toml`；安装默认只修改当前 shell；安装前文件清单和确认；无参数打开原生 TUI、任务在 TUI 输入；额度提示词无需重复；单连接代理图；全平台 loopback/token 边界及不使用无 token Unix socket 的原因；`codex-raw` 和 BYPASS；管理 allowlist、`exec` 拒绝、未知命令；config 命令；DORMANT + ALLOWED；quota/guard/turns 分离；严格模式；恢复 PATH；真实路径失效诊断；Codex App、IDE 和其他进程不受控；不记录 prompt/output/approval；无模型验收边界。

- [ ] **步骤 5：更新变更记录和发布清单**

CHANGELOG 新增 `0.3.0`，明确 remote 能力仍是现场探测的实验接口和安全退化条件。RELEASE_CHECKLIST 新增 shell 三平台、透明代理、token、raw、BYPASS、fake E2E、tarball、无模型真实 TUI、config.toml 哈希和资源残留检查。

- [ ] **步骤 6：保持三平台 CI 的完整质量门**

专属 workflow 继续使用 Node 20.19.0 的 macOS、Ubuntu、Windows 矩阵，顺序保持：

```text
npm ci --ignore-scripts
npm ls --depth=0
npm run format:check
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

确认 `test/fakes/*.mjs` 在三平台使用 `process.execPath`，不依赖 shebang 或 Unix 执行权限；三平台都使用带 token 的 loopback WebSocket。

- [ ] **步骤 7：运行文档、打包和完整测试并提交**

运行：

```bash
npm run format:check
npm run typecheck
npm test
npm run build
npm ls --depth=0
npm pack --dry-run --cache /private/tmp/codex-quota-guard-npm-cache
```

预期：全部退出码 0；tarball 含 dist、README、CHANGELOG、RELEASE_CHECKLIST 和 `ws` 运行时依赖声明，不含 test、临时 socket、token、状态或认证文件。

```bash
git add .github/workflows/codex-quota-guard.yml tools/codex-quota-guard
git commit -m "docs: 准备 Codex Quota Guard 0.3.0 默认终端集成"
```

## 任务十四：完整验证、临时 HOME shell 验收和真实无模型 TUI 验收

**文件：**

- 修改：`docs/codex-quota-guard-plan.md`，只追加实际命令、退出码、测试数量、资源检查和 CI 链接

- [x] **步骤 1：执行干净依赖安装和全部自动质量门**

运行：

```bash
npm ci --ignore-scripts --cache /private/tmp/codex-quota-guard-npm-cache
npm test
npm run typecheck
npm run format:check
npm run build
npm ls --depth=0
npm pack --dry-run --cache /private/tmp/codex-quota-guard-npm-cache
```

预期：全部退出码 0；测试数不少于原有 130 项加本计划新增用例；测试日志没有真实 Codex、真实账户或真实 `turn/start`。

- [x] **步骤 2：生成 tgz 并安装到隔离 prefix**

运行：

```bash
npm pack --pack-destination /private/tmp --cache /private/tmp/codex-quota-guard-npm-cache
npm install --prefix /private/tmp/codex-quota-guard-0.3-prefix /private/tmp/codex-quota-guard-0.3.0.tgz --ignore-scripts --cache /private/tmp/codex-quota-guard-npm-cache
```

预期：仓库外可执行入口出现；安装过程不创建 `codex`、`codex-raw`、profile 块或全局 Guard 配置。

- [x] **步骤 3：在临时 HOME 和临时 PATH 中交互验证当前 zsh 安装**

创建空 `/private/tmp/codex-quota-guard-shell-home`，记录 `.zshrc`、`.bash_profile` 和真实 Codex 文件哈希。进入以该 HOME 启动的真实 zsh TTY，运行：

```bash
codex-quota-guard shell install --codex-path "/Applications/ChatGPT.app/Contents/Resources/codex"
```

查看文件清单后输入 `INSTALL`，再运行：

```bash
source ~/.zshrc
codex-quota-guard shell status
command -v codex
command -v codex-raw
codex --version
codex-raw --version
```

预期：只创建临时 HOME 的 `.zshrc` 标记块、全局 Guard 配置与两个 shim；`.bash_profile` 未变化；`codex` 解析到 shim；wrapper 版本、保存路径和原始版本正确；没有 App Server 或模型 turn。

- [x] **步骤 4：验证 BYPASS、管理命令和未知命令**

在同一临时 zsh TTY 运行：

```bash
codex raw --version
CODEX_QUOTA_GUARD_BYPASS=1 codex --version
codex completion zsh
codex exec --help
codex future-command
```

预期：前三项执行保存的真实绝对路径；BYPASS 不改变随后 `codex` 路由；`exec` 明确拒绝；未知命令等待明确选择，输入 `cancel` 后不执行真实 Codex。机器输出 stdout 未被旁路警告污染。

- [x] **步骤 5：验证卸载幂等和零残留**

运行 `codex-quota-guard shell uninstall`，查看清单后输入 `UNINSTALL`，重开临时 zsh 并检查：

```bash
codex-quota-guard shell status
command -v codex
test ! -e ~/.local/share/codex-quota-guard/shims/codex
test ! -e ~/.local/share/codex-quota-guard/shims/codex-raw
```

再执行一次 uninstall，预期返回“已卸载”。`.zshrc` 恢复原内容或原不存在状态；真实 Codex 哈希不变；无 shim、完整或残缺标记块、监听端口、token 文件或后台子进程。

- [x] **步骤 6：执行真实 Codex 无模型 remote TUI 验收**

该步骤允许使用真实登录态，但不输入任何提示、不执行 slash command、不启动 turn。若配置文件存在则记录 SHA-256；不存在则记录 `ABSENT` 哨兵。再记录本会话前的 App Server PID 集合：

```bash
shasum -a 256 ~/.codex/config.toml
pgrep -fl "codex app-server"
```

在真实 PTY 中运行 tgz 安装的：

```bash
codex-quota-guard interactive --codex-path "/Applications/ChatGPT.app/Contents/Resources/codex"
```

只确认原生 TUI 首屏出现，立即按 Ctrl-C 退出。再次比较 `~/.codex/config.toml` 哈希和 App Server PID 集合，确认没有 Guard loopback 监听、token 文件或后台子进程。不得自动输入 prompt，不得执行真实 interrupt、Goal 或 live canary；如需任何真实 turn，必须另行取得用户明确许可。

- [x] **步骤 7：执行范围、敏感信息和协议完成度审计**

运行：

```bash
git diff --check
git status --short
git diff 1167217..HEAD --name-only
rg -n "accessToken|refreshToken|Authorization: Bearer|cookie=" tools/codex-quota-guard docs/codex-quota-guard-plan.md
```

预期：改动只在设计允许范围；搜索结果只出现脱敏规则或测试假值，不出现真实认证材料。逐条审查代理请求、响应、通知、server request、审批、未知字段、Guard ID、active target、DORMANT、HANDLED 和 cleanup 的直接测试证据。

- [x] **步骤 8：推送最终功能分支并等待三平台 CI**

提交本计划末尾的实际验收记录并推送 `codex-quota-guard` 分支。查询最终 HEAD 对应的 `Codex Quota Guard` workflow；macOS、Ubuntu、Windows 三个 job 必须全部成功，且每个 job 都运行完整测试与 pack。不能用旧 SHA 或本机测试替代远端平台证据。

- [x] **步骤 9：执行逐项完成审计**

按下方覆盖矩阵为每个要求记录文件、测试、命令、真实无模型验收或 CI 证据。任何条目缺证据、结果间接、真实配置被修改、资源残留或某平台失败，都继续修复，不得把 Goal 标记为 complete。

```bash
git add docs/codex-quota-guard-plan.md
git commit -m "docs: 记录默认 Codex 终端启动器验收结果"
```

## 需求覆盖矩阵

| 要求 | 实施任务 | 直接证据 |
|---|---:|---|
| 核心 300 分钟、2% 下降沿、weekly 只显示、同 key 一次、HANDLED 放行 | 六、十二、十四 | `guard-state-machine.test.ts`、`controller.test.ts`、fake edge/weekly E2E |
| `interactive` 无命令行提示并打开原生 TUI | 七、八、十二、十四 | CLI 解析/运行时测试、fake TUI、真实无模型首屏 |
| 单连接代理且 Guard 是唯一上游客户端 | 二、三、五、七 | raw process、proxy、client、session 测试 |
| 请求、响应、通知、未知方法/字段透明 | 二、三、十二 | transparent proxy 单元测试与 E2E transcript |
| 双向 server request、审批和用户输入 | 三、十二 | server request ID 冲突测试、fake 审批往返 |
| Guard ID 与 TUI ID 不冲突 | 三 | 数字/字符串/同值三方向 ID 测试 |
| 精确 active thread/turn 与旧 generation 隔离 | 六、十二 | controller 通知测试、旧事件不触及 second turn E2E |
| 全平台 loopback、随机 endpoint、token、单客户端 | 四、十二、十四 | endpoint 平台测试、真实无模型首屏、三平台 CI |
| token 不在命令行、日志、状态、报告、文件或上游环境 | 四、七、十二、十四 | endpoint/session/脱敏测试、范围与残留审计 |
| Ctrl-C、TUI/App Server/代理崩溃清理 | 七、十二 | session fault matrix 与 E2E crash |
| shell install/status/uninstall 当前 shell、确认、回滚、幂等 | 十、十四 | installer 事务测试、临时 HOME zsh 验收 |
| 不替换真实 Codex、不修改 config.toml | 十、十四 | 哈希测试与真实无模型前后哈希 |
| `codex-raw` 与一次性 BYPASS | 十一、十四 | router/child 测试、临时 shell 命令 |
| 管理命令、exec、version、未知子命令路由 | 十一、十三、十四 | 路由表、帮助测试、临时 shell 验收 |
| 全局配置与项目配置分离 | 九、十 | global store 与 CLI config 测试 |
| 默认 DORMANT + ALLOWED 和严格模式 | 五、七、八、十二 | preflight、client、CLI、weekly-only E2E |
| 不控制 App、IDE、raw 或其他进程 | 七、十一、十四 | session 仅清理直接子进程与当前 thread 的测试 |
| 自动测试零真实额度 | 十二至十四 | fake 可执行路径审计、测试日志与 CI |
| npm tarball 安装后可用 | 十三、十四 | pack 清单、临时 prefix 与 shell 验收 |
| macOS、Linux、Windows | 四、十、十二至十四 | 平台分支测试与最终 HEAD Actions |

## 原目标 26 项新增测试索引

1. 无参数路由：任务十一 `shell-router.test.ts`。
2. 交互参数：任务八、十一。
3. 管理命令：任务十一。
4. `codex-raw`：任务十一。
5. BYPASS 一次性：任务十一。
6. wrapper 递归：任务十、十一。
7. 空格路径：任务十、十一。
8. 真实路径移动/删除：任务十一。
9. 未知 shim 冲突：任务十。
10. install 两次：任务十。
11. uninstall 两次：任务十。
12. 卸载恢复解析：任务十、十四。
13. zsh/bash/PowerShell：任务十与三平台 CI。
14. PATH 顺序诊断：任务十。
15. TUI/Guard ID 冲突：任务三。
16. 双向 server request：任务三、十二。
17. 审批往返：任务三、十二。
18. 未知通知和方法：任务二、三、十二。
19. TUI 断开清理：任务七、十二。
20. App Server 断开：任务七、十二；现有 manager 重连测试继续覆盖非交互路径。
21. Ctrl-C 清理：任务七、十二。
22. 额度边沿固定 turn：任务六、十二。
23. HANDLED 后后续 turn：任务十二。
24. weekly 不触发：任务六、十二。
25. 全部旧测试：每个任务聚焦回归，任务十三、十四运行全量。
26. 三平台 CI：任务十三、十四。

## 计划阶段停止点（历史记录）

本计划最初写入并通过自审时在此停止，没有开始实现。用户随后明确批准设计并选择在当前会话执行计划，实施与验收结果记录如下。

## 默认终端启动器实际验收记录（2026-07-13，macOS）

### 本地质量门与发布包

- 最终功能代码验收 HEAD：`4647cf9213428fdd5afcd05140f445e3ee1a1367`。
- `npm ci --ignore-scripts --cache /private/tmp/codex-quota-guard-npm-cache`：退出码 0，安装 50 个包，漏洞数 0。
- `npm test`：退出码 0，29 个测试文件、303 项测试全部通过；Windows 仅跳过无有效权限位语义的 Unix 权限测试、POSIX `PATH` 夹具和既有平台专属路由测试，原生 PowerShell、分号 `PATH`、`.cmd` shim、子进程退出与 loopback 流程均有 Windows runner 直接证据；全部自动测试使用 fake transport/fake Codex，没有真实模型 turn。
- `npm run typecheck`、`npm run format:check`、`npm run build`、`npm ls --depth=0`、`npm pack --dry-run`、`git diff --check`：退出码均为 0。
- 最终功能代码发布包：`/private/tmp/cqg-0.3-final-pack-20260713-4647cf9/codex-quota-guard-0.3.0.tgz`；SHA-256 为 `3b6e8ca5f2a7bc2539568cde448877c1eb22627dba7a0cf69b2372bc231ec486`；47 个发布文件，只含构建产物、README、CHANGELOG、发布清单、包元数据与 `ws` 运行时依赖声明。安装到 `/private/tmp/cqg-0.3-final-prefix-20260713-4647cf9` 后，受支持的 `--help` 与包元数据版本 `0.3.0` 均验证成功。
- tarball 隔离安装：`/private/tmp/cqg-0.3-final-prefix-20260713-4647cf9`；npm 安装只创建 `codex-quota-guard` 包入口，没有自动创建 `codex`、`codex-raw`、profile 块或 Guard 全局配置。

### macOS 行为等价候选 tarball 的临时 zsh 验收

完整 TTY 安装/卸载事务使用修复前候选 tarball 执行；此后唯一生产代码差异是把非 Windows profile 从宿主 `path.join` 明确为 `path.posix.join`，二者在 macOS 上结果相同。最终功能代码 tarball 已按上节重新打包、隔离安装并验证帮助与版本，最终 Windows 安装路径行为由三平台 CI 直接验证。

- 临时 HOME：`/private/tmp/cqg-shell-release-home-20260713`；安装前 `.zshrc` 与 `.bash_profile` 均不存在。
- `shell install` 在真实 zsh TTY 中列出影响文件，精确输入 `INSTALL` 后退出码 0；`shell status --json` 返回 `already-installed`、`healthy: true`、`issues: []`。
- `command -v codex` 与 `command -v codex-raw` 均解析到临时 HOME 的受管 shim；wrapper 为 `0.3.0`，保存路径为 `/Applications/ChatGPT.app/Contents/Resources/codex`，保存和实测版本均为 `codex-cli 0.144.0-alpha.4`；`codex-raw --version` 原样返回真实版本。
- `codex raw --version`、单次 `CODEX_QUOTA_GUARD_BYPASS=1`、管理命令、`exec` 拒绝和未知命令 `cancel` 已在同类 tarball TTY 验收；自动路由回归由 `shell-router.test.ts`、`cli-runtime.test.ts` 和 `shell-installer.test.ts` 直接覆盖。
- `shell uninstall` 精确输入 `UNINSTALL` 后退出码 0；重复 status/uninstall 为 `already-uninstalled`；`.zshrc`、`.bash_profile`、两个 shim 和标记块均不存在。禁用状态的 Guard 配置不含真实路径或认证材料。
- 实机验收曾发现“原本不存在的 profile 被恢复成空文件”，已用 `profileOriginallyExisted` 持久事实修复；测试同时证明原有空 profile 与安装后新增的用户内容不会被误删。
- 真实 Codex 二进制安装前后 SHA-256 均为 `fba7b05624324ce44777b174fe6da1bcf08ef8cba634d85ecfaacbd8fa49aa8d`。临时 HOME 下的 `.codex` 目录是同一真实 Codex 在版本/schema 探测时生成的自身运行状态，不是 Guard shim、token 或真实用户配置改动。

### 真实 Codex 无模型 TUI 验收

- 最终命令来自发布 tarball，并在 `/private/tmp/cqg-real-tui-release-work-20260713` 的真实 PTY 中运行；只附加原生 `--no-alt-screen` 便于验收，没有输入 prompt 或 slash command。
- 当前 Codex 明确报错说明 `--remote-auth-token-env` 只允许与 `wss://` 或 loopback `ws://` 组合。为保留随机 token 认证，最终实现统一改为只监听 `127.0.0.1` 随机端口；未通过取消 token 退化到 Unix socket。
- 原生 TUI 首屏保持运行超过 10 秒；单次 `Ctrl-C` 后约 1.57 秒自然退出，最终命令退出码 0。回归测试把断线宽限固定为 3 秒，并覆盖 1.5 秒的正常原生进程收尾。
- 最终状态读取自 `rateLimitsByLimitId.codex`：weekly `67% used`、`33% left`，没有 300 分钟窗口；`guard: DORMANT`、`turnsStarted: 0`、`activeTurn: null`、`errors: []`。weekly 仅显示，未调用 `turn/interrupt`，也没有真实模型调用。
- TUI 下游断开时代理先暂停下游并保留唯一上游，控制器完成 `thread/backgroundTerminals/clean` 后再关闭代理；fake E2E transcript 和真实状态 `errors: []` 共同验证该清理顺序。
- `~/.codex/config.toml` 验收前后 SHA-256 均为 `06d95d3ce4326c3d24422d9c2610c82506a024bbfae767865fa8dd25e91d8ca4`。
- 验收前后均无 `codex app-server` 残留 PID、无 Node loopback 监听、无 `cqg-??????` 临时目录，也没有 token 文件。随机 token 未进入命令行、状态、报告、配置、上游环境或公开 transcript。

### 范围、安全与 CI 状态

- `git diff 1167217..HEAD --name-only` 仅包含 `tools/codex-quota-guard/**`、专属 `.github/workflows/codex-quota-guard.yml`、本计划和已获确认的同主题设计文档；没有业务源码、根 package、根 TypeScript/Vitest 配置或无关文档改动。
- 敏感词审计命中仅为脱敏规则、fake transport 和测试假值；没有真实 token、cookie 或认证头。
- 300 分钟唯一保护窗口、2% 下降沿、同 key 一次、HANDLED 后放行、weekly 永不触发、DORMANT + ALLOWED、重复 updated、固定 active turn、App Server 崩溃、持久状态、Goal 降级、loopback token、双向 server request、审批、未知字段、路由和清理均有直接单元或 fake E2E 证据。
- 用户明确授权后已向 `myfork`（`https://github.com/nan-doctor/llm_wiki.git`）推送 `codex-quota-guard` 分支。最终功能代码 HEAD `4647cf9213428fdd5afcd05140f445e3ee1a1367` 对应的 [Codex Quota Guard 运行 #29248875100](https://github.com/nan-doctor/llm_wiki/actions/runs/29248875100) 全部通过：macOS、Ubuntu、Windows 三个 job 均完成 `npm ci --ignore-scripts`、依赖树、格式、类型、303 项测试、构建和 `npm pack --dry-run`。
- 首轮 Windows 失败揭示了宿主路径规则、Unix 权限位和子进程信号回调的测试边界；实现已明确对非 Windows profile 使用 POSIX 路径，测试改为由父进程观测子进程实际退出。第二轮把剩余差异收敛到 fake App Server 的 `SIGTERM` 回调，最终同样改用父进程 `stop()` 完成事件验证；没有用重跑掩盖失败。
- `git diff 1167217..HEAD --name-only` 仍只包含独立工具、专属 workflow、本计划和已确认的同主题设计文档；`git diff --check` 通过，敏感词命中全部为脱敏规则或测试假值。功能代码提交与远端在审计时为 `0 0` 同步。为避免“记录 CI 结果”产生无限验收提交链，本验收记录提交本身的最终三平台结果保留在任务完成报告中。
