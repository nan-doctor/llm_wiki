# Codex Quota Guard 默认终端启动器设计

## 目的

为已经稳定的 Codex Quota Guard 增加受保护的原生交互入口与可逆 shell 集成。安装完成后，用户在终端输入 `codex` 即进入原生 Codex TUI，实际任务仍在 TUI 内输入，不需要在命令行提供提示词，也不需要重复描述额度保护规则。

本次工作是增量集成，不改写现有 300 分钟窗口识别、2% 一次性下降沿、精确 turn 中断、Goal 降级、可执行文件 resolver 或单轮命令行为。

## 已验证的协议事实

设计依据 2026-07-13 本机安装版本的实际输出和现场 schema：

- PATH Codex：`codex-cli 0.131.0`；
- ChatGPT 内置 Codex：`codex-cli 0.144.0-alpha.4`；
- 两个版本的 `codex --help` 都包含 `--remote` 和 `--remote-auth-token-env`；
- 两个版本的 `codex app-server --help` 都支持 `stdio://`、`unix://PATH` 和 `ws://IP:PORT`；
- Unix socket 传输实际使用 WebSocket HTTP Upgrade，不是 JSONL；
- stdio 传输使用一行一条消息的 JSONL；
- 当前 schema 包含初始化、请求、响应、通知、server request、审批、用户输入、额度、thread、turn、Goal 和后台 terminal 方法；
- 已用真实 App Server 和临时 Unix socket 打开原生 TUI 后立即退出，全程没有输入提示词或启动模型 turn。

由于远程 TUI 和网络传输仍属于实验能力，每次启动交互会话时都重新验证所选 Codex 的版本、`--remote` 帮助文本与现场 schema，不能沿用另一个二进制的能力结论。

## 不变保护语义

以下行为继续由现有状态机决定：

- 只有 `windowDurationMins === 300` 的窗口参与保护；
- weekly 和其他窗口只显示，永远不触发中断；
- 同一五小时 windowKey 最多处理一次；
- 事件只中断下降沿瞬间原子保存的 `threadId` 和 `turnId`；
- `HANDLED` 后允许同一 TUI 中的后续 turn；
- 五小时窗口不可见时为 `DORMANT + ALLOWED`；
- `--require-protection` 在 `DORMANT` 或等待安全基线时拒绝启动；
- 不增加全局永久停止 latch，也不恢复单一 `STOPPED` 系统状态。

交互模式只增加 active turn 的观察入口和传输适配，不复制或重新实现这些判断。

## 方案选择

### 采用：单连接透明代理

```text
原生 Codex TUI
  ↕ 本地 WebSocket
Codex Quota Guard 透明代理
  ↕ JSONL stdio
真实 Codex App Server
```

真实 App Server 只有一个 stdio 客户端，即 Quota Guard 代理。TUI 连接代理提供的本地 endpoint。Guard 在同一上游连接中观察消息并注入自己的请求。

### 不采用：两个客户端直接连接

让 TUI 和 Guard 分别连接同一个 App Server 会产生订阅、server request、审批归属和 active turn 对账歧义，也违背“Guard 是唯一控制客户端”的要求。

### 不采用：终端抓取或进程附加

解析 TUI 字符、扫描进程或附加到独立 Codex 无法保留 JSON-RPC 语义，也不能可靠得到精确 turnId，因此不作为退化实现。

## 组件边界

### 1. `InteractivePreflight`

在打开 TUI 前完成：

1. 使用现有 resolver 选择并验证真实 Codex；
2. 重新生成 schema 并确认 remote、额度读取与精确中断能力；
3. 用短生命周期 App Server 完成 initialize、initialized 和额度读取；
4. 让现有 GuardController 处理快照并持久化当前状态；
5. 输出简短启动状态；
6. 应用显式参数或全局配置中的严格保护要求；
7. 关闭预检 App Server。

预检不调用 `thread/start` 或 `turn/start`。在第一次额度读取前，它以“新交互会话”作用域整理持久化状态：未被现有 `HANDLING` 事件固定引用的陈旧 active turn 必须先清除；已经固定到事件的 target 保留给现有崩溃恢复逻辑。这样，预检观察到新的五小时下降沿时只能关联本次会话后来观察到的 turn，绝不会中断上一次进程留下的 threadId/turnId。如果此时没有 active turn，继续沿用现有“记录事件但没有中断目标”的语义，不虚构目标。

### 2. `RawAppServerProcess`

新增只负责字节和 JSONL 消息的上游进程传输：

- 使用已解析的真实绝对路径启动 `codex app-server --listen stdio://`；
- 不自行 initialize；
- 逐行解析 App Server stdout；
- 接受任意 JSON-RPC 请求、响应和通知；
- server request 不被拒绝，而是交给透明代理；
- stderr 仅作为递归脱敏后的诊断，不写入用户消息或认证内容；
- 进程退出时拒绝 Guard 的 pending request 并通知会话协调器。

现有 `ProcessAppServerConnection` 继续服务单轮命令，保留其明确拒绝交互式 server request 的原行为。交互代理不会修改这一稳定实现。

### 3. `LocalTuiEndpoint`

向原生 TUI 提供一个只允许单个客户端的本地 WebSocket endpoint：

- macOS/Linux：在权限为 `0700` 的随机临时目录中创建 Unix socket，socket 权限收紧到 `0600`；
- Windows：监听随机的 `127.0.0.1:0` 端口；
- 不监听非 loopback 地址；
- 两类 endpoint 都要求随机 capability token；
- token 只保存在 Guard 进程内存和 TUI 子进程环境中；
- 真实 App Server 在生成 token 前启动，且其子进程环境中不得出现该 token；
- TUI 命令行仅包含 `--remote-auth-token-env CODEX_QUOTA_GUARD_REMOTE_TOKEN`，不包含 token 值；
- 不创建 token 文件，不把 token 写入状态、报告或日志；
- HTTP Upgrade 时以常量时间比较验证 `Authorization: Bearer ...`；
- 第二个连接直接拒绝，避免多 TUI 会话共享状态。

Node.js 20 没有内置 WebSocket server，工具增加小型运行时依赖 `ws`，只用于本地 endpoint 和测试。不会把真实 App Server 改为实验 WebSocket 上游；上游仍使用稳定的 stdio JSONL。

### 4. `JsonRpcTransparentProxy`

代理按消息方向处理，不按已知方法白名单过滤。

#### TUI 到 App Server

- 请求：把原始请求 ID 映射为 `cqg-tui:<sessionNonce>:<counter>`，其余字段原样转发；
- 通知：原样转发；
- 对 server request 的响应：保留 App Server 原始 ID，原样转发；
- 未知方法和未知字段：原样保留。

#### App Server 到 TUI

- TUI 请求的响应：查映射表恢复 TUI 原始 ID，其余字段原样转发；
- Guard 请求的响应：只解析到 Guard pending promise，不发送给 TUI；
- 通知：先向 Guard 观察器发出只读事件，再原样发送给 TUI；
- server request：保留原始 ID 和完整参数发送给 TUI；
- 未知方法和未知字段：原样保留。

#### Guard 注入请求

- 使用 `cqg-guard:<sessionNonce>:<counter>`；
- 不与任何 TUI 映射 ID 共用计数器或前缀；
- 只有完成 TUI 的 initialize/initialized 握手后才能发送；
- 请求超时只影响 Guard 控制结果，不伪造 TUI 响应。

请求 ID 的方向也参与分类，因此 App Server 主动请求的 ID 可以与 TUI 自己的请求 ID 数值相同，仍不会混淆响应关系。

### 5. `InteractiveAppServerClient`

抽取 GuardController 所需的最小结构接口：

```ts
interface GuardAppServerClient {
  start(): Promise<void>
  stop(): Promise<void>
  request<T>(method: string, params?: unknown): Promise<T>
  refreshRateLimits(): Promise<GetAccountRateLimitsResponse>
  waitForIdle(): Promise<void>
  on(event: string, listener: (...args: unknown[]) => void): this
  off(event: string, listener: (...args: unknown[]) => void): this
}
```

现有 AppServerManager 和新的交互代理客户端都实现该接口。GuardController 只把构造参数从具体类改为该接口，不改变额度状态转移与中断实现。

交互客户端在 TUI 转发 `initialized` 之后执行首次 `account/rateLimits/read`。在首次快照处理完成前，代理可以转发初始化和只读启动查询，但暂存 TUI 的 `turn/start`；GuardController 准备完成后按原顺序释放，避免用户极快输入导致 turn 先于保护状态建立。

### 6. `InteractiveSession`

协调预检、代理、控制器和 TUI 子进程：

1. 取得现有项目控制器进程锁；
2. 执行预检和严格准入；
3. 创建随机会话 ID 与临时目录；
4. 启动上游 stdio App Server；
5. 启动本地 endpoint；
6. 把 GuardController 监听器附加到交互客户端；
7. 以真实 Codex 绝对路径启动 `codex --remote <endpoint>`；
8. 将用户选定的原生 TUI 参数原样附加；
9. TUI 完成握手和首次额度处理后释放 `turn/start`；
10. 等待 TUI、App Server、代理或信号中的第一个终止条件；
11. 按统一清理流程退出并传播 TUI 退出码。

TUI 使用 `stdio: inherit`，保持原生终端绘制、slash commands、审批和用户输入体验。Guard 不读取终端字符。

## active thread 与 turn 跟踪

交互 TUI 自己调用 `thread/start`、`thread/resume` 和 `turn/start`，因此 GuardController 增加只读通知处理：

- `thread/started`：保存当前会话最近观察到的 threadId；
- `turn/started`：从同一通知原子保存精确 `threadId`、`turn.id` 和时间；
- `turn/completed`：只在 threadId 和 turnId 同时匹配时清除 active turn；
- 新的 `turn/started` 会替换已经结束的 active turn，但不能改写已创建阈值事件的固定 target；
- TUI 断线后，当前会话 generation 失效，任何延迟消息不得更新下一会话状态。

交互会话启动时清除没有固定在 `HANDLING` 事件中的陈旧 active turn，再等待当前代理观察新 turn。已经原子保存到阈值事件的 target 不被清除，崩溃恢复仍按现有逻辑处理。

阈值处理继续执行：

1. 持久化事件与固定 target；
2. 注入精确 `turn/interrupt`；
3. 通过匹配通知或 `thread/read` 对账终态；
4. 尝试保存并暂停 Goal；
5. 清理该 thread 的后台 terminal；
6. 标记同一 windowKey 为 `HANDLED`；
7. TUI 保持打开，后续 turn 继续允许。

## 启动显示与严格模式

打开 TUI 前输出：

```text
Codex Quota Guard: active
Codex executable: /absolute/path/to/codex
5h: 34% left
weekly: 18% left (informational only)
quota: SAFE
guard: ARMED
turns: ALLOWED
Bypass: codex-raw
```

五小时窗口不可用时输出：

```text
5h protection: UNAVAILABLE
weekly: 18% left (informational only)
guard: DORMANT
turns: ALLOWED
```

该显示复用现有额度格式化结果，额度严重程度、保护器状态和新 turn 准入保持为三个独立字段。例如五小时剩余不高于 2% 且同一窗口已经完成一次性中断时，必须同时显示 `quota: CRITICAL`、`guard: HANDLED` 和 `turns: ALLOWED`，不得合并成单一 `STOPPED` 状态。

`codex-quota-guard interactive --require-protection` 和全局 `defaultRequireProtection: true` 使用相同准入。显式 `--require-protection` 只能强制开启严格模式；未传该参数时读取全局默认，不提供会悄悄覆盖全局严格设置的反向参数。严格模式在 TUI 子进程创建前拒绝，不出现短暂打开后退出的界面。

## TUI 参数边界

直接命令使用：

```text
codex-quota-guard interactive [Guard 选项] -- [原生 TUI 参数]
```

Guard 选项只包括 `--codex-path` 和 `--require-protection`。`--` 后的参数原样交给真实 Codex，但 Guard 始终自行添加并拥有 `--remote` 与 `--remote-auth-token-env`；用户传入这两个参数时拒绝启动，防止绕开代理。

shell wrapper 中，首个 token 以 `-` 开头时视为原生交互参数并进入 guarded interactive。用户不需要命令行提示词；未知位置子命令不会自动当作提示词。

## 统一清理

所有退出路径使用幂等清理器，逆序处理：

1. 停止接收新的 TUI 消息；
2. 若当前会话有精确 active turn，尽力调用一次 `turn/interrupt`；
3. 若已知当前 thread，尽力清理它的后台 terminal；
4. 关闭 TUI WebSocket；
5. 向 TUI 子进程发送平台适用的温和终止信号，超时后再强制结束；
6. 停止真实 App Server 子进程；
7. 关闭 HTTP/WebSocket server；
8. 删除 Unix socket 和随机临时目录；
9. 清除内存中的 token 和 ID 映射；
10. 保存脱敏错误与最新本地状态；
11. 释放控制器进程锁；
12. 移除信号监听器。

正常退出、Ctrl-C、终端关闭、TUI 崩溃、App Server 崩溃和代理异常都进入同一清理器。App Server 已退出时无法注入中断，报告必须准确写明“未确认中断”，不能假装成功。

清理只作用于本次直接创建的子进程、endpoint 和已观察 thread，不扫描或终止其他 Codex、Codex App、IDE 或 `codex-raw` 会话。

## 全局与项目配置

现有项目配置 `.codex-guard/config.json` 继续保存项目级 `codexPath` 等设置，不承担全局 wrapper 身份。

shell 集成使用平台用户数据目录中的原子 JSON 配置：

- macOS/Linux：`~/.local/share/codex-quota-guard/config.json`；
- Windows：`%LOCALAPPDATA%/codex-quota-guard/config.json`。

配置形状向后兼容地包含：

```ts
interface GlobalGuardConfig {
  defaultInteractiveProtection: boolean
  defaultRequireProtection: boolean
  realCodexExecutable: string | null
  realCodexVersion: string | null
  shellIntegration: {
    enabled: boolean
    shimDirectory: string | null
    installedAt: string | null
    shells: Array<{
      shell: "zsh" | "bash" | "powershell"
      profilePath: string
    }>
  }
}
```

全局配置使用 `0600` 文件、`0700` 目录、临时文件同步和原子重命名。不得保存 token、cookie 或认证材料。

`config show` 合并显示全局默认、当前项目覆盖和来源。`config set default-require-protection true|false` 只更新全局 Guard 配置，不读取或修改 `~/.codex/config.toml`。

`defaultInteractiveProtection` 默认且安装时必须为 `true`。首版不提供把它设为 `false` 的公开 `config set` 命令；如果手工配置为 `false`，shim 必须拒绝启动并明确提示 `codex-raw`，不得静默执行真实 Codex。这样保留配置的向后兼容形状，同时不引入隐式绕过保护的路径。

## shell 安装设计

用户已批准默认只修改当前执行 shell。其他 shell 需要切换到对应 shell 后再次执行安装；每次安装仍是幂等的，已有其他 shell 的安装记录和标记块不得被当前操作改写。

### 位置

- macOS/Linux shim：`~/.local/share/codex-quota-guard/shims/codex` 和 `codex-raw`；
- Windows shim：用户数据目录下 `shims/codex.cmd` 和 `codex-raw.cmd`。

shim 只调用当前已安装的 `codex-quota-guard` CLI，不覆盖、移动或修改真实 Codex。安装前 resolver 得到真实路径和版本，并保存到全局配置。wrapper 启动 guarded interactive 时把这个路径作为已验证的显式候选交给现有 resolver，禁止重新从已被 shim 前置的 PATH 猜测；直接调用 `codex-quota-guard interactive --codex-path ...` 时仍保留现有显式覆盖语义，不改变 resolver 的其他稳定入口。

### 当前 shell 与 profile

- macOS zsh：`~/.zshrc`；
- macOS bash：`~/.bash_profile`；
- Linux zsh：`~/.zshrc`；
- Linux bash：`~/.bashrc`；
- Windows PowerShell：通过当前 PowerShell 解析 `CurrentUserCurrentHost` profile 路径。

无法可靠识别当前 shell 或 profile 时拒绝修改，并显示可恢复的手工命令；不猜测文件。

### 安装事务

1. 显示真实 Codex、shim、Guard 配置和 shell profile 的绝对路径；
2. 要求交互终端中明确输入确认；
3. 非 TTY 环境直接拒绝，不接受静默安装；
4. 检查目标 shim：不存在则继续，内容带本工具完整标记且校验匹配则视为幂等，其他内容一律冲突；
5. 原子写入带版本、真实路径和校验标记的 shim；
6. 在 profile 中加入唯一的可逆标记块，把 shim 目录放到 PATH 最前；
7. 原子保存全局配置；
8. 启动对应 shell 的隔离验证命令，确认 `codex` 解析到本工具 shim；
9. 执行 wrapper 的只读身份检查，确认其内部真实 Codex 路径等于安装时保存路径；
10. 任一步失败时撤销本次新增的标记块和 shim，并提供准确手工恢复路径。

profile 标记块不覆盖用户其他内容。已有相同完整块视为幂等；只有开始或结束标记、内容被修改或出现多块时视为冲突并拒绝自动修复。

### 状态检查

`shell status` 检查并显示：

- 全局集成配置；
- 当前 shell 与 profile；
- 两个 shim 是否存在、是否由本工具管理、校验是否匹配；
- profile 标记块是否完整且唯一；
- 新 shell 中 `codex` 是否解析到 shim；
- shim 保存的真实 Codex 是否仍存在、可执行且版本匹配；
- 当前 PATH 顺序不正确时给出需要重开终端或修正 profile 的诊断。

### 卸载事务

1. 读取全局配置和本工具标记；
2. 只移除当前 shell profile 中完整匹配的标记块；
3. 只有 shim 内容和校验仍匹配时才删除；用户修改过的文件保留并报冲突；
4. 更新全局配置；
5. 验证新的 shell 不再优先解析到本工具 shim；
6. 若没有其他 shell 记录，删除空 shim 目录；
7. 第二次卸载返回“已卸载”，不报错。

卸载不删除真实 Codex、不修改 Codex 配置，也不清除额度 `HANDLED` 记录。

## shim 命令路由

路由先读取全局真实 Codex 路径，再验证它不是当前 shim 或 Guard 自己的路径，并重新执行 resolver 的文件、权限、`--version` 和 `app-server --help` 检查。`codex-raw`、`codex raw`、BYPASS 和管理命令始终直接执行这个已保存的绝对路径，不重新查 PATH；路径缺失或验证失败时拒绝，不回落到可能指向 shim 的同名命令。只有用户直接调用 Guard CLI 并显式给出 `--codex-path` 时，才允许本次 guarded interactive 使用另一个真实 Codex。

| 输入 | 行为 |
|---|---|
| `codex` | guarded interactive |
| `codex --<原生交互参数>` | guarded interactive，并转发兼容 TUI 参数 |
| `codex raw ...` | 原样执行真实 Codex，等价于 `codex-raw ...` |
| `codex-raw ...` | 原样执行真实 Codex，不启动 Guard |
| `CODEX_QUOTA_GUARD_BYPASS=1 codex ...` | 仅本次原样执行真实 Codex |
| `codex login/logout/mcp/app-server/completion ...` | 输出一行旁路说明后执行原生管理命令 |
| `codex exec ...` | 明确拒绝，并提示使用 `codex-quota-guard run` 或 `codex-raw exec` |
| `codex --version` | 显示 wrapper 版本、真实路径与真实版本 |
| 未识别位置子命令 | TTY 中显示解析结果并要求用户明确选择；非 TTY 直接失败 |

管理命令采用保守 allowlist，并可包含当前 Codex 明确存在的 `plugin`、`mcp-server`、`remote-control`、`completion`、`update`、`doctor` 和 `features`。新版本出现的未知子命令不会自动旁路。

旁路警告写入 stderr。仅当 stdin 或 stderr 为终端时显示醒目警告；机器可读管道保留真实 Codex stdout 和退出码。BYPASS 环境变量只在当前进程读取，不持久化、不改变后续调用，也不修改 guard 状态。

## 错误策略

- 真实路径丢失、变为 shim、不可执行或版本探测失败：拒绝启动，显示保存路径、失败阶段、额度读取/中断影响及 `doctor --codex-path` 修正命令；
- remote 或 schema 能力缺失：不采用脆弱代理，明确建议 `codex-guarded` 安全退化入口；
- 五小时窗口不可见：默认显示 `DORMANT + ALLOWED`；严格模式拒绝；
- TUI 握手失败：关闭本会话 App Server 和 endpoint，不重试到另一个 Codex；
- Guard 注入请求失败：不吞掉 TUI 消息，保存脱敏诊断；阈值事件按现有失败语义完成报告；
- server request 无 TUI 响应：由真实 App Server 的超时语义决定，代理不伪造审批结果；
- shell 冲突：拒绝覆盖并列出冲突文件和只删除本工具标记的恢复步骤；
- 配置写入失败：安装事务回滚，不留下半个 PATH 标记或单个 shim；
- 所有日志和报告继续经过递归认证字段脱敏。

## 测试设计

自动测试不启动真实模型。

### 路由与旁路

- `codex` 无参数进入 guarded interactive；
- 原生交互参数原样转发，用户 `--remote` 被拒绝；
- 管理命令透明执行真实 Codex 并传播退出码；
- `codex exec` 不静默旁路；
- `codex-raw` 与一次性 BYPASS；
- wrapper 版本输出；
- 未知子命令的 TTY 选择和非 TTY 失败；
- 路径含空格、真实文件移动或删除、递归路径拒绝。

### shell 集成

- zsh、bash、PowerShell profile 标记块；
- 未知目标文件冲突；
- install 两次、uninstall 两次；
- 卸载恢复命令解析；
- PATH 顺序错误诊断；
- 非 TTY 拒绝；
- 中途失败事务回滚；
- 用户修改过的 shim 或标记块不被删除；
- 只安装当前 shell，不修改其他 profile；
- `~/.codex/config.toml` 前后哈希不变。

### JSON-RPC 代理

- TUI 与 Guard ID 命名空间不冲突；
- TUI 数字和字符串 ID 都可往返恢复；
- 双向 server request 保持原 ID；
- 命令审批、文件审批、权限审批和用户输入请求透明往返；
- 未知请求、通知、响应字段透明保留；
- 多客户端拒绝；
- capability token 缺失或错误时拒绝；
- token 不进入命令行、日志、状态或报告；
- 初始化前不能注入 Guard 请求；
- 首次额度准备前暂存 `turn/start`；
- TUI 或 App Server 断开时 pending request 正确失败。

### 交互控制器

- `turn/started` 保存精确 active turn；
- 匹配的 `turn/completed` 才清除；
- 旧 session generation 的通知无效；
- 阈值事件只中断固定 turn；
- `HANDLED` 后同一 TUI 的新 turn 正常运行；
- weekly 低额度不触发；
- DORMANT 默认允许、严格模式拒绝；
- Ctrl-C、TUI 崩溃和 App Server 崩溃走幂等清理；
- 清理不扫描或中断其他 Codex 会话。

### Fake 端到端

增加 Fake TUI 与 Fake App Server 子进程：

```text
Fake TUI
  → initialize / initialized
  → thread/start / turn/start
Guard proxy
  → ID 映射与观察
Fake App Server
  → thread/started / turn/started
  → account/rateLimits/updated 跨越 2%
Guard proxy
  → 注入精确 turn/interrupt
Fake TUI
  → 在 HANDLED 后创建新 turn
断言旧事件不触及新 turn
```

该测试同时覆盖未知通知、审批 server request、TUI 断开和所有临时资源清理。

### 回归与平台

- 保留所有现有状态机、manager、resolver、doctor、持久化和 UI 测试；
- macOS、Linux、Windows CI 均运行全部 fake 测试、类型检查、构建和打包；
- Unix 平台覆盖 Unix socket；Windows 覆盖 `127.0.0.1` WebSocket 和 PowerShell profile；
- npm tarball 临时安装后，在临时 HOME/PATH 中完成 install/status/version/raw/uninstall 流程。

## 真实验收边界

实现完成后允许在不输入提示词的情况下：

- 对最终 npm tarball 执行 shell install/status/uninstall；
- 校验真实 Codex 和 `~/.codex/config.toml` 的前后哈希；
- 启动真实 App Server 与 `codex --remote`；
- 确认 TUI 首屏出现后立即退出；
- 确认没有残留 socket、token 文件、App Server 或 TUI 子进程。

不得自动输入真实 prompt、触发模型 turn、额度中断或 Goal 操作。任何真实 turn canary 都需要用户再次明确授权。

Guard 的安装、启动、预检和代理代码不得编辑 `~/.codex/config.toml`，也不得主动调用 `config/write`、`config/value/write` 或 `config/batchWrite`。代理仍透明转发用户在原生 TUI 中主动发起的原生配置操作；这不属于 shell 集成的写入权限。自动验收只打开首屏并退出，必须证明该文件哈希不变。

## 文件影响范围

计划中的改动只位于：

- `tools/codex-quota-guard/`：代理、interactive、shell、配置、测试、README、CHANGELOG、发布清单和包版本；
- `docs/superpowers/specs/`：本设计；
- `docs/`：实施计划；
- `.github/workflows/codex-quota-guard.yml`：三平台测试步骤如有必要的最小增量。

不复用或修改仓库根 TypeScript/Vitest 配置，不修改主应用业务代码和其他文档。

## 完成判据

- 无参数 `codex` 打开受保护原生 TUI；
- wrapper、真实 Codex、Guard 和 App Server 路径无递归；
- 普通消息、模型输出、工具调用、审批和未知协议消息透明；
- Guard 请求 ID 与 TUI 请求 ID 不冲突；
- 当前会话 active turn 可被现有一次性边沿逻辑精确中断；
- 五小时窗口、weekly、HANDLED、DORMANT 和严格模式语义不变；
- shell 安装只修改用户确认的当前 shell，完整可逆且幂等；
- `codex-raw` 与 BYPASS 可靠且明确；
- 不修改真实 Codex、认证文件或 `~/.codex/config.toml`；
- 所有自动测试、npm tarball 临时安装和三平台 CI 通过；
- 真实无模型 TUI 验收通过且没有资源残留；
- README 和恢复说明准确覆盖所有已知副作用与限制。
