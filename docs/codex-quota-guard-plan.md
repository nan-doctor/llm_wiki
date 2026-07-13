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
