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
