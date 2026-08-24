# Otto 集成 DSH 全特性运行时总体规划

状态：规划草案

目标仓库：`Felix201209/otto`

Otto 基线：`internal@30e2adab7bf9d647ff69965bbbbcf1044b3e3014`

DSH 基线：`master@b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（`0.1.1-rc.2`）

## 1. 目的

本规划定义 Otto 如何完整获得 DeepSeek Harness（下称 DSH）的稳定产品能力，同时保留 Otto 已有的桌面端、企业服务、飞书、知识治理、文档专家、RPA、商业控制和安全发布体系。

本项目不是把 DSH 的工具逐个复制进 `packages/core`，也不是用 DSH 重写整个 Otto。目标是建立可替换的 Agent Runtime 边界，把 DSH 作为隔离运行时接入 Otto，并让 Otto 产品层通过稳定协议消费会话事件、控制运行状态和呈现用户交互。

最终形态必须满足以下条件：

1. DSH 负责 Agent 循环、会话事件、工具组合、Profile、插件、后台任务、终端、子 Agent、工作流、压缩和运行时恢复。
2. Otto 负责桌面和企业产品体验、身份、授权、商业策略、飞书、知识治理、文档工作流、RPA、发布、更新和组织级审计。
3. 两者之间只有版本化协议和显式适配层，不允许 Desktop 或 Server 直接导入 DSH 内部源码。
4. Otto 旧运行时在迁移期继续可用，但同一会话创建后不得在两个运行时之间切换。
5. 高风险行为无论由哪个运行时发起，都必须经过 Otto 中央策略、用户确认和审计链路。

## 2. 范围定义

### 2.1 “DSH 全特性”的正式范围

首轮完成定义覆盖 DSH 当前公开发行中以下组合和稳定产品包：

- `dsh-base` 默认组合。
- `dsh-web-app` 浏览器交互组合。
- `dsh-headless` 非交互组合。
- 会话、事件日志、Projection、Checkpoint、标题和查询。
- LLM 路由、流式响应、Token 计量、重试和压缩。
- 文件系统、Shell、PowerShell、LSP、Web、MCP 和 Skills。
- 权限预设、Sandbox、审批、提问、命令和计划模式。
- Todo、Goal、Schedule、Feedback、Background Jobs 和持久终端。
- Subagent spawn、fork、continue、report、list 和 follow-up。
- Workflow、Ralph、worker-thread 执行和结果呈现。
- Attachment、Spill、Storage、Settings 和 Credentials。
- Profile、Bundle、Preset、插件清单、热加载和受控自修改。
- Web Host/API Gateway、JSON-RPC SDK、ACP Server 和 Headless 入口。
- TypeScript/Python SDK 可观察的核心协议行为。

### 2.2 暂不纳入首轮完成定义

- DSH `experimental/` 下的私有原型。
- 实验性 Agent Teams，除非其能力已经进入公开稳定组合。
- E2B POC；首轮只保留 provider 扩展位。
- 对 DSH Web UI 的像素级复制。功能语义必须等价，视觉仍使用 Otto 设计系统。
- 将 Otto 企业、飞书和商业模块回迁到 DSH 上游。
- 在迁移过程中重写 Otto 已稳定运行的文档、RPA、知识和企业服务实现。

### 2.3 兼容性立场

DSH 仍处于 RC 阶段，没有稳定协议兼容承诺。因此 Otto 必须：

- 固定 DSH 精确提交和产物摘要，禁止无门禁追踪 `master`。
- 通过 Adapter 隔离 DSH 类型，Otto 产品代码只能依赖 `runtime-contracts`。
- 为协议、事件和 Profile 建立黄金快照。
- 每次升级单独提交，附带兼容报告、迁移说明和回滚产物。
- 将 DSH MIT 许可证和第三方声明纳入 Otto Apache-2.0 发行物的 NOTICE/SBOM。

## 3. 当前状态与差距

### 3.1 Otto 已具备的能力

Otto 当前已经具备以下可复用能力：

- 流式对话、模型适配和场景化模型路由。
- 文件读取、写入、编辑、补丁、批量编辑、Glob、Grep 和代码搜索。
- Shell、Web Fetch、Web Search、LSP、MCP、Skills、Todo、Ask User。
- 本地时间、日程、记忆、知识库和会话检查点。
- Task 子 Agent、Workflow、外部 ACP Agent 委托和资源预算。
- 中央策略、审批模式、审计日志和高风险工具分类。
- Electron 桌面端、本地/企业 Server、飞书和组织级能力。
- 文档生成、PPT、数据分析、桌面自动化、Web 自动化和 RPA。
- 企业附件、E2EE、知识治理、组件清单和更新签名基础。

### 3.2 关键结构性缺口

Otto 与 DSH 的主要差距不是工具数量，而是运行时语义：

1. Otto 工具仍由 `Config.createToolRegistry()` 集中硬编码，缺少 Profile/Bundle/Preset 的组合能力。
2. `OttoComponentManifest` 目前主要提供类型和校验，尚未形成统一加载、作用域、卸载和回滚链路。
3. 会话主要保存 `history.json` 快照，没有 DSH 式类型化 append-only 事件日志和 Projection 真相源。
4. `splitSession()` 创建的是新的会话元数据，不等价于按事件边界 Fork 并继承模型历史。
5. 缺少通用 Background Jobs、持久 PTY、工具结果 Spill、Ralph 和完整 Plan Review。
6. Subagent 缺少可继续子进程、统一 mailbox、报告通道和持久 lineage。
7. VM Workflow 仍是探索性路径；耐久工作流尚未覆盖任意子 Agent 和外部副作用。
8. Sandbox 目前没有形成 Linux Landlock/bwrap、macOS Seatbelt 和 Windows 受限进程的一致 provider 链路。
9. Otto 只有 ACP Client，没有完整 ACP Server、通用 JSON-RPC Runtime SDK 和 Headless 产品入口。
10. Desktop 和 Server 的部分状态仍直接读取内部对象，尚未全部由事件 Projection 驱动。

## 4. 总体架构

```text
┌────────────────────────────────────────────────────────────┐
│ Otto 产品层                                                │
│ Desktop / Enterprise Server / Feishu / Admin / RPA / Docs │
└───────────────────────────┬────────────────────────────────┘
                            │ runtime-contracts
┌───────────────────────────▼────────────────────────────────┐
│ Otto Runtime Gateway                                       │
│ session control / event projection / policy / audit / auth │
└───────────────┬──────────────────────────┬─────────────────┘
                │                          │
┌───────────────▼──────────────┐ ┌────────▼─────────────────┐
│ Legacy Otto Runtime Adapter │ │ DSH Runtime Adapter       │
│ migration only              │ │ process + protocol owner  │
└──────────────────────────────┘ └────────┬─────────────────┘
                                         │ authenticated local IPC
                              ┌──────────▼──────────────────┐
                              │ Pinned DSH Runtime Process  │
                              │ Otto Profile + DSH plugins  │
                              └─────────────────────────────┘
```

### 4.1 为什么采用独立进程

DSH 使用 pnpm monorepo和 Cordis 插件生命周期，Otto 使用 npm workspaces、Electron、Server 和现有核心对象。直接把 DSH 源码合并进 `packages/core` 会产生依赖解析、生命周期、全局单例、版本升级和崩溃隔离问题。

独立进程方案提供以下保证：

- DSH 升级不会把内部类型扩散到 Otto 产品包。
- Agent 崩溃、插件泄漏或 stdout 污染不会直接终止 Electron 主进程。
- 每个运行时可使用经过清理的环境变量和单独的文件权限。
- Desktop、本地 Server 和企业 Worker 可以复用同一个协议。
- 可以在不迁移旧会话的情况下并行运行 Legacy 与 DSH Runtime。
- 可以独立签名、校验、更新和回滚 DSH 运行时产物。

### 4.2 新增工作区

建议新增以下目录：

```text
packages/
  runtime-contracts/       # Otto 稳定运行时协议和领域类型
  runtime-gateway/         # 会话路由、策略、事件归一化和运行时选择
  runtime-dsh/             # DSH 进程监管、协议客户端和事件翻译
  runtime-legacy/          # 旧 Otto Client/Turn/ToolRegistry 的适配器
runtime/
  dsh/
    profile/               # Otto 的 profile manifest 和 cordis.patch.yml
    presets/               # standard / minimal / code / enterprise
    plugins/               # Otto 专用 DSH plugins
    patches/               # 临时上游兼容补丁，必须有退出条件
    manifests/             # 固定版本、摘要、许可证、SBOM
```

产品包只依赖 `runtime-contracts` 或 `runtime-gateway`。`packages/core` 不直接依赖 Cordis、DSH Web UI 或 DSH provider 实现。

## 5. 稳定运行时协议

### 5.1 Runtime 接口

`runtime-contracts` 至少定义：

```ts
interface AgentRuntime {
  initialize(request: RuntimeInitializeRequest): Promise<RuntimeInfo>;
  createSession(request: CreateSessionRequest): Promise<SessionDescriptor>;
  resumeSession(sessionId: string): Promise<SessionDescriptor>;
  prompt(request: SessionPromptRequest): Promise<PromptReceipt>;
  steer(request: SessionSteerRequest): Promise<void>;
  cancel(request: SessionCancelRequest): Promise<CancelReceipt>;
  closeSession(sessionId: string): Promise<void>;
  forkSession(request: SessionForkRequest): Promise<SessionDescriptor>;
  respondApproval(request: ApprovalResponse): Promise<void>;
  respondQuestion(request: QuestionResponse): Promise<void>;
  controlJob(request: JobControlRequest): Promise<JobDescriptor>;
  controlSubagent(request: SubagentControlRequest): Promise<void>;
  subscribe(filter: RuntimeEventFilter): AsyncIterable<RuntimeEvent>;
  shutdown(reason: RuntimeShutdownReason): Promise<void>;
}
```

禁止产品层获得 DSH `ctx`、Cordis Service、Loader Entry 或内部 Agent 实例。

### 5.2 协议方法

最小协议方法集：

- `runtime/initialize`
- `runtime/health`
- `runtime/shutdown`
- `session/create`
- `session/resume`
- `session/prompt`
- `session/steer`
- `session/cancel`
- `session/close`
- `session/fork`
- `session/export`
- `session/query`
- `approval/respond`
- `question/respond`
- `job/list`
- `job/stop`
- `job/collect`
- `subagent/list`
- `subagent/followup`
- `subagent/interrupt`
- `plugin/list`
- `plugin/configure`
- `settings/read`
- `settings/update`

通知至少包括：

- `session.event`
- `session.status`
- `approval.requested`
- `question.requested`
- `job.updated`
- `subagent.started`
- `subagent.updated`
- `subagent.finished`
- `runtime.health_changed`
- `runtime.upgrade_required`

### 5.3 协议版本

握手必须包含：

- `protocolVersion`
- `runtimeName`
- `runtimeVersion`
- `runtimeCommit`
- `capabilities[]`
- `eventSchemaVersion`
- `profileDigest`
- `buildDigest`
- `platform`

主版本不兼容时拒绝启动；次版本通过 capability negotiation 降级。禁止忽略未知的高风险事件。

## 6. 会话事件与数据模型

### 6.1 事件日志是真相源

所有会影响模型上下文、用户界面、审批、恢复或审计的事实必须写入 append-only 会话事件日志。最小事件集合：

- `session/created`
- `session/forked`
- `session/closed`
- `turn/started`
- `turn/ended`
- `step/started`
- `step/ended`
- `user/message`
- `assistant/chunk`
- `assistant/message`
- `tool/call`
- `tool/approval_requested`
- `tool/approval_resolved`
- `tool/result`
- `tool/error`
- `tool/cancelled`
- `job/started`
- `job/updated`
- `job/finished`
- `subagent/started`
- `subagent/finished`
- `goal/updated`
- `plan/updated`
- `checkpoint/committed`
- `attachment/registered`
- `spill/registered`
- `runtime/error`

事件信封必须包含 `eventId`、`sessionId`、`sequence`、`timestamp`、`schemaVersion`、`turnId`、`stepId`、`actor`、`traceId`、`payload` 和 `ignorable`。

### 6.2 Projection

从事件日志派生以下 Projection：

- 模型历史。
- Desktop 会话消息流。
- 工具调用树。
- 会话标题与统计。
- Goal 和 Plan 状态。
- Background Job 列表。
- Subagent 树和活动状态。
- Token、费用与延迟。
- 产物和附件列表。
- 审批时间线。
- 全文检索和 lineage。

Projection 可以缓存，但必须能从事件日志完整重建。任何 UI 不得自行解析原始工具输出形成第二套业务规则。

### 6.3 存储后端

首轮支持：

- 本地 JSONL 事件日志。
- 本地 SQLite Projection/FTS 索引。
- 内容寻址 Attachment/Spill 存储。
- 企业 PostgreSQL 事件镜像和对象存储引用。

每次写入必须先持久化事件，再向 UI 广播。Projection 更新失败不得丢失原始事件。

## 7. Profile、Bundle、Preset 与插件

### 7.1 Otto Profile

至少提供四个 Agent Preset：

- `minimal`：只读文件、搜索、时间和低成本模型。
- `standard`：文件编辑、Shell、Web、Skills、MCP、Todo、Subagent。
- `code`：标准能力加 LSP、代码模式、工作流和持久终端。
- `enterprise`：标准能力加 Otto 企业知识、飞书、审计和组织策略插件。

Profile 层级顺序固定为：

1. 固定 DSH base。
2. Otto 产品 Bundle。
3. 部署 Bundle。
4. 用户 Profile patch。
5. 会话级 Preset。
6. 受控临时 overlay。

后层只能通过稳定 ID 替换前层配置。禁止通过路径深导入或修改 DSH agent-loop 获得产品定制。

### 7.2 插件生命周期

所有注册必须返回 disposer，并绑定到明确作用域：

- Runtime scope
- Profile scope
- Session scope
- Agent scope
- Tool-call scope

插件卸载后必须撤销工具、事件监听器、计时器、服务、路由和资源句柄。重复加载同一插件不得产生重复注册。

### 7.3 受控自修改

Agent 可以检查插件和生成候选插件，但挂载必须满足：

- 只写入隔离的用户插件目录。
- 静态扫描通过。
- Manifest、权限和依赖声明完整。
- 高风险 capability 需要用户确认。
- 运行前生成摘要和审计事件。
- 支持一键卸载和回滚。
- 企业部署可以完全禁用自修改。

## 8. Capability 实现计划

### 8.1 文件系统与编辑

保留 Otto 现有工具名称兼容层，同时把执行转交 DSH FS provider。覆盖读取、写入、目录、Glob、Grep、批量读取、字符串替换、Patch 和 MultiEdit。

验收条件：

- 所有路径通过统一 workspace policy。
- 符号链接和路径穿越测试通过。
- 修改前可生成预览和确认。
- 工具输出统一记录 location 和 diff render intent。

### 8.2 Shell、PowerShell 与持久终端

采用 DSH subprocess、shell 和 terminal seam：

- Windows 使用 PowerShell provider。
- macOS/Linux 使用 Bash provider。
- 持久终端按 session/agent 所有权隔离。
- 支持写入、读取、调整大小、关闭和超时回收。
- 后台 Shell 自动注册为 Job。

验收条件：Desktop 重连后能继续观察终端；运行时退出会回收所有子进程树。

### 8.3 Sandbox

按平台实现：

- Linux：Landlock 或 bwrap provider。
- macOS：Seatbelt provider。
- Windows：受限 Token、Job Object、ACL 和网络策略组合。
- 不支持的平台必须 fail loud，不得假装已隔离。

Sandbox policy 支持 `read-only`、`workspace-write` 和 `danger-full-access`，并与 approval policy 独立组合。

### 8.4 Background Jobs

统一 Job 领域模型：

- `queued`
- `running`
- `awaiting_approval`
- `stopping`
- `succeeded`
- `failed`
- `cancelled`
- `unknown_outcome`

Shell、Terminal、Subagent 和 Workflow 都可以产生 Job，但不能各自维护独立 Job Map。Job 结果必须支持 bounded collect 和 spill reference。

### 8.5 Web、MCP、LSP 和 Skills

复用 Otto 已有产品配置和 DSH capability：

- Web Search/Fetch provider 可替换并带 SSRF 策略。
- MCP discovery、OAuth、工具同步、断线恢复和响应 guard 保留 Otto 安全能力。
- LSP 通过统一 subprocess/fs world 运行，切换 Sandbox provider 时无需重写。
- Skills 由 host/global 和 session/agent 两层目录组成。

### 8.6 Plan、Todo、Goal、Schedule 和 Feedback

- Plan 是持久会话状态，不是单个内存布尔值。
- 进入 Plan 后所有变更型工具仍可出现在 schema 中，但执行策略必须拒绝。
- `exit_plan_mode` 只提交待审计划；用户批准后由新一轮执行状态切换。
- Todo 与实现执行关联，不代替 Plan。
- Goal 有预算、状态、继续驱动、完成和用户清除语义。
- Schedule 生成可追溯的后续输入，并在事件日志中记录触发原因。
- Feedback 绑定具体 assistant message 和可选说明。

### 8.7 Subagent

实现以下能力：

- Spawn：新上下文子 Agent。
- Fork：继承父会话指定边界之前的事件历史。
- Continuable：完成一个回合后继续等待 follow-up。
- Report：子 Agent 主动向直接父 Agent 报告。
- List：返回当前 session tree、状态和任务。
- Follow-up：向指定子 Agent 发送后续任务。
- Interrupt：安全中断并留下终态事件。

所有子 Agent 必须继承资源预算上限，但权限只能保持或收缩，不能扩大。

### 8.8 Workflow 与 Ralph

Workflow 使用 worker-thread provider，定义必须版本化并带稳定 `runId`、`stepId`、revision 和 idempotency key。

Ralph 作为 Workflow Consumer：

- 每轮使用新 Agent。
- 固定最大轮数、Token、费用和时间预算。
- 每轮输出写入事件和工作流 trace。
- 达成条件、预算耗尽、用户取消和错误都有明确终态。

旧 VM Workflow 只能处理探索性脚本；不可宣称可恢复，也不能执行不可逆副作用。

### 8.9 Attachment 与 Spill

- 二进制内容存储在日志之外。
- 会话事件只保存内容摘要、MIME、大小、内容哈希和授权引用。
- 工具结果超过阈值后写入 Spill，模型只获得预算内摘要和引用。
- Attachment/Spill 的读取必须重新执行会话和租户授权。
- 删除、保留和企业对象存储生命周期保持可审计。

### 8.10 Settings 与 Credentials

- Settings 支持文件热加载、版本和校验。
- Credentials 只通过引用传递，优先级为受管凭据、环境引用、项目 `.env`。
- 运行时子进程默认使用 scrubbed environment。
- API Key、Cookie、E2EE 私钥和长期凭据不得进入事件、日志、Checkpoint 或错误文本。
- Desktop 设置页面只写入受管存储，不直接修改运行时进程环境。

## 9. Otto 专用 DSH 插件

下列能力通过 Otto 插件接入 DSH，不能写入 DSH 核心循环：

1. `otto-policy-bridge`：调用 Otto CentralPolicy，生成审批和审计事实。
2. `otto-model-router`：把 SceneManager/企业模型配置投影为 DSH LLM routes。
3. `otto-audit-sink`：把 DSH 事件归一化后写入 Otto 本地或企业审计。
4. `otto-memory-provider`：接入个人记忆、Mem0 和企业知识检索。
5. `otto-skill-provider`：接入 Otto Skill 市场、个人 Skill 和企业发布策略。
6. `otto-feishu-tools`：提供飞书协作能力并保留移动端交互语义。
7. `otto-document-tools`：提供文档、PPT、表格和数据分析能力。
8. `otto-rpa-tools`：提供受策略控制的浏览器/桌面 RPA。
9. `otto-enterprise-context`：注入租户、组织、岗位和授权范围。
10. `otto-worklog`：把可交付成果和工作记录投影到 Otto 产品界面。

每个插件必须声明所需 capability、权限、配置 schema、事件、工具、数据所有者和失败策略。

## 10. Desktop 与 Server 集成

### 10.1 Electron Main

新增 Runtime Manager，负责：

- 验证 DSH 运行时签名和摘要。
- 分配 loopback 端口或命名管道。
- 生成一次性认证 token。
- 启动、监控、重启和关闭子进程。
- 转发事件到 Renderer。
- 处理升级不兼容、崩溃循环和诊断收集。

Renderer 不得直接访问运行时文件、进程句柄或凭据。

### 10.2 Renderer

Renderer 只消费 Projection：

- 会话时间线。
- 工具调用树和 diff。
- Plan/Goal/Todo。
- Background Jobs。
- Terminal cards。
- Subagent tree。
- Approval/Question composer。
- Produced files、Attachment 和 Spill。
- Plugin inventory、Model 和 Permission settings。

### 10.3 Local/Enterprise Server

Server 通过相同 Runtime Gateway 创建远程或本地执行：

- 绑定 tenant、account、workspace、profile 和 permission snapshot。
- 不继承 Desktop Cookie 或 E2EE 私钥。
- 服务器任务使用工作负载身份和短期 credential reference。
- 任务事件进入企业持久层，但本地私聊明文仍遵守 E2EE 边界。

## 11. 迁移方案

### 11.1 会话迁移

旧 Otto 会话按以下方式导入：

1. 读取旧 metadata、history、checkpoint 和 token stats。
2. 生成 `session/imported` 事件，记录来源格式和摘要。
3. 将用户、助手和工具历史转换为有序事件。
4. 无法证明顺序或调用关系的数据标记 `legacy_unattributed`。
5. 生成 Projection 并与旧 UI 快照对比。
6. 保留旧文件为只读归档，不原地覆盖。

导入失败时旧会话仍由 Legacy Runtime 打开；不得生成半迁移会话。

### 11.2 运行时选择

运行时选择写入 `SessionDescriptor.runtime`：

- `legacy-otto`
- `dsh-otto`

选择只在创建会话时发生。会话运行期间禁止静默切换。升级后无法读取的 DSH 会话显示明确错误和恢复选项，不回退到 Legacy Runtime 猜测执行。

### 11.3 灰度顺序

1. 开发者 opt-in。
2. 内部 Headless 和只读任务。
3. 新建本地编码会话。
4. Desktop 标准用户灰度。
5. 企业测试租户。
6. 企业正式租户。
7. DSH 成为新会话默认运行时。
8. Legacy Runtime 只读窗口。
9. 删除 Legacy 执行路径。

## 12. 安全设计

### 12.1 进程与传输

- 本地监听只绑定 loopback 或用户级命名管道。
- 每次启动生成一次性 token，token 不写入普通日志。
- Web transport 校验 Origin、Host 和 token。
- JSON-RPC stdout 只允许协议帧，诊断写 stderr。
- 子进程环境采用 allowlist，不继承无关秘密。
- Runtime Manager 限制启动命令、工作目录和可加载 Profile。

### 12.2 策略与审批

所有工具先经过：

```text
schema validation
  -> capability permission
  -> workspace/sandbox policy
  -> Otto CentralPolicy
  -> user/enterprise approval
  -> audit intent
  -> execution
  -> redacted receipt
  -> audit outcome
```

拒绝、取消、超时和审批通道断开都是明确终态。禁止把审批失败降级为自动允许。

### 12.3 供应链

- 固定 DSH commit、lockfile 和完整依赖图。
- 构建产物生成 SHA-256、SBOM、许可证清单和 provenance。
- Otto 发行时校验运行时与 Profile digest。
- 上游升级执行差异扫描、协议兼容测试和安全回归。
- 临时 patch 必须记录上游 Issue、原因、测试和删除条件。

## 13. 可观察性与诊断

统一标识：

- `runtimeId`
- `sessionId`
- `turnId`
- `stepId`
- `toolCallId`
- `jobId`
- `subagentId`
- `workflowRunId`
- `traceId`

指标至少包括：

- Runtime 启动时间、崩溃率和重启次数。
- 首 Token 延迟、回合延迟、工具延迟。
- Token、费用和压缩次数。
- Job/Terminal/Subagent 数量和生命周期。
- 审批等待、拒绝和超时。
- Spill 大小和 Attachment 读取。
- Projection 重建时间和事件积压。
- Sandbox 拒绝、策略拒绝和协议错误。

诊断包必须脱敏，并包含版本、Profile digest、能力协商结果和最近的结构化错误；不得包含 Prompt、原始工具结果或凭据。

## 14. 测试战略

### 14.1 单元测试

- Runtime contract parser。
- Event schema 和版本迁移。
- Projection reducer。
- Policy bridge。
- DSH-to-Otto event translator。
- Session runtime routing。
- Profile overlay resolver。

### 14.2 合同测试

同一测试套件同时运行在 `runtime-legacy` 与 `runtime-dsh`：

- 创建/恢复/关闭会话。
- Prompt 收据和事件顺序。
- 工具成功、失败、取消和审批。
- Fork、Job、Subagent 和 Workflow。
- 传输断开与重连。
- 不兼容协议拒绝。

### 14.3 快照测试

从 DSH `base/web/headless` 已有场景建立 Otto 对应快照：

- 新会话与连续对话。
- 工具调用和终端卡片。
- Plan review。
- Goal 多轮执行。
- Todo 并行状态。
- Background Job。
- Subagent 树和中断。
- Workflow run。
- Web Search。
- Skill 调用。
- Permission 和 Approval。
- 生成文件、Attachment 和 Spill。

### 14.4 故障注入

- Runtime 在模型流中退出。
- Runtime 在工具副作用前后退出。
- Desktop 断开和重连。
- Projection 写入失败。
- JSONL 尾部损坏。
- SQLite 索引丢失并重建。
- 子进程拒绝退出。
- MCP 服务卡死。
- Sandbox backend 不可用。
- Credential provider 超时。

确认过的外部副作用不得重复；无法判断的操作进入 `unknown_outcome`。

### 14.5 平台矩阵

- Windows x64/arm64。
- macOS Intel/Apple Silicon。
- Ubuntu x64/arm64。
- 4GB、8GB 和高资源设备档位。
- 本地 Desktop、Headless、SSH 和企业 Worker。

## 15. 分阶段交付

### Phase 0：基线与决策冻结

交付物：

- DSH 功能清单和黄金快照索引。
- 固定版本 manifest、许可证和 SBOM。
- Runtime ADR。
- `runtime-contracts` 初版。
- 风险登记表。

退出条件：所有团队同意范围、协议、进程模型和回滚路径。

### Phase 1：Headless Runtime Spike

交付物：

- DSH 子进程启动和关闭。
- Initialize、Prompt、事件流和健康检查。
- 模型、文件、Shell、Web、Skills、MCP、Todo。
- 只读开发者开关。

退出条件：固定任务集在 DSH Adapter 上稳定通过，关闭后无孤儿进程。

### Phase 2：事件源会话

交付物：

- Event Store、Projection 和迁移器。
- Resume、Fork、Export、Query。
- Desktop 消息和工具视图改为 Projection 驱动。

退出条件：重启后可从日志恢复；删除 Projection 后能无损重建。

### Phase 3：交互与安全

交付物：

- Approval、Question、Permission presets。
- Plan、Goal、Todo、Schedule、Feedback。
- CentralPolicy 和 Audit bridge。
- 三平台 Sandbox provider。

退出条件：安全评测和拒绝路径 100% 通过。

### Phase 4：Jobs、Terminal 与 Subagent

交付物：

- Background Jobs 和持久 Terminal UI。
- Spawn/Fork/Continue/Report/List/Follow-up/Interrupt。
- 资源预算、超时、spill 和进程树回收。

退出条件：Desktop 重启、网络断开和 Runtime 重启场景通过。

### Phase 5：Workflow、Ralph 与耐久执行

交付物：

- Worker-thread Workflow。
- Ralph。
- Checkpoint、幂等、`unknown_outcome` 和人工接管。
- 与 `packages/workflow` 的单一真相源整合。

退出条件：任意步骤故障恢复不重复已确认副作用。

### Phase 6：Otto 产品能力插件化

交付物：

- Memory、Skill、Feishu、Document、RPA、Enterprise 插件。
- 企业身份和权限上下文。
- Produced files 与 Worklog Projection。

退出条件：原有 Otto 关键产品回归全部通过，插件可独立禁用。

### Phase 7：Web、SDK、ACP 与企业 Worker

交付物：

- Otto Web Host 集成。
- 完整 JSON-RPC SDK。
- ACP Server。
- 企业远程 Runtime/Worker。
- 管理员运行时和插件清单。

退出条件：Desktop、Web、Headless、ACP 和企业 Worker 使用同一运行时语义。

### Phase 8：默认切换与 Legacy 移除

交付物：

- 新会话默认 DSH。
- 旧会话迁移报告。
- Legacy 只读窗口和最终移除 PR。
- 发布、升级、回滚和运维文档。

退出条件：连续两个正式版本无 P0/P1 回退，Legacy 执行代码不再被生产入口引用。

## 16. Issue 拆分建议

每项应成为独立、可回滚 Issue：

1. 定义 AgentRuntime 接口与版本握手。
2. 建立 DSH 固定版本 manifest、SBOM 和许可证归档。
3. 实现 DSH Runtime Process Supervisor。
4. 实现 NDJSON/Host API 传输和认证。
5. 实现 DSH Event Translator。
6. 实现 Runtime Gateway 和会话级 runtime pin。
7. 建立 append-only Session Event Store。
8. 建立模型历史 Projection。
9. 建立 Desktop 会话和工具 Projection。
10. 实现旧 Otto 会话导入器。
11. 实现真实 Session Fork 与 lineage。
12. 实现 Plan/Goal/Todo/Schedule/Feedback 状态。
13. 接入 Otto CentralPolicy、Approval 和 Audit。
14. 实现三平台 Sandbox provider。
15. 实现统一 Background Job 服务。
16. 实现持久 Terminal 和 Desktop 卡片。
17. 实现 Continuable Subagent 与 mailbox。
18. 实现 Workflow/Ralph 和耐久恢复。
19. 实现 Attachment/Spill 内容寻址存储。
20. 实现 Settings/Credentials 热加载和秘密引用。
21. 实现 Otto Memory/Knowledge 插件。
22. 实现 Otto Skills/Marketplace 插件。
23. 实现 Otto Feishu/Enterprise 插件。
24. 实现 Otto Documents/RPA 插件。
25. 实现独立 Web Host 和管理面。
26. 实现 ACP Server 和完整 Runtime SDK。
27. 建立 DSH parity 快照和故障注入套件。
28. 建立灰度、遥测、回滚和发布门禁。
29. 切换新会话默认 Runtime。
30. 移除 Legacy Runtime 生产执行路径。

每个 Issue 必须包含：行为目标、非目标、受影响协议、事件、数据迁移、安全风险、测试、回滚方式和可观察性。

## 17. 发布门禁

任何阶段进入正式渠道前必须满足：

1. `npm run doctor`、边界检查、类型检查和相关测试通过。
2. DSH runtime digest、Profile digest、SBOM 和许可证清单完整。
3. 协议合同、事件快照和迁移测试通过。
4. 高风险工具审批、拒绝、取消和审计路径通过。
5. 三平台进程清理和 Sandbox 验证通过。
6. Runtime 崩溃、断网和重启恢复通过。
7. 无原始秘密进入事件、日志、Checkpoint、Spill 摘要或诊断包。
8. 性能不低于已批准基线，弱设备档位没有无界并发或内存增长。
9. 发布产物支持一键回滚到前一固定 Runtime。
10. 用户可见行为有对应类型事件或状态，不只存在于日志。

## 18. 风险与缓解

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| DSH RC 接口快速变化 | Adapter 频繁破坏 | 固定提交、协议隔离、黄金快照、单独升级 PR |
| 两套运行时长期共存 | 行为漂移和维护成本 | 会话级 pin、统一合同测试、明确 Legacy 删除里程碑 |
| DSH 与 Otto 都拥有策略 | 双重审批或策略绕过 | Otto CentralPolicy 为最终权威；DSH policy 作为本地前置防线 |
| 事件量和存储增长 | 启动慢、磁盘膨胀 | Projection cache、压缩、Spill、保留策略、分页读取 |
| 子进程和终端泄漏 | 资源耗尽 | 进程树所有权、Job Object、退出阶梯、周期性清理 |
| 插件自修改引入供应链风险 | 任意代码执行 | 默认关闭、隔离目录、静态扫描、确认、签名和回滚 |
| Desktop 与 Server 状态不一致 | 用户看到错误状态 | 事件日志真相源、幂等 sequence、重连补放 |
| 企业数据进入本地日志 | 合规风险 | 数据分类、租户授权、脱敏事件、企业存储策略 |
| 直接复用 DSH Web API 内部细节 | 升级脆弱 | Otto Runtime Protocol 包装，不允许产品层依赖内部方法 |

## 19. 完成定义

只有满足以下全部条件，才可以宣称 Otto 已实现 DSH 全部稳定特性：

- DSH `base + web + headless` 稳定产品能力在 Otto 中有等价入口。
- 所有模型可见输入都可从类型化会话事件日志重建。
- Profile、Bundle、Preset 和插件具有真实加载、隔离、卸载和回滚能力。
- 文件、Shell、Terminal、Jobs、Web、MCP、LSP、Skills 和编辑工具通过统一 capability/policy 路径运行。
- Plan、Goal、Todo、Schedule、Feedback、Subagent、Workflow 和 Ralph 状态持久且可恢复。
- Session Resume、Fork、Export、Query、Projection 和 FTS 工作正常。
- Attachment、Spill、Settings 和 Credentials 有明确存储、安全和生命周期语义。
- Desktop、Web、Headless、SDK、ACP 和企业 Worker 使用同一事件和控制协议。
- 三个平台的 Sandbox、进程回收、故障恢复和安全评测通过。
- Otto 的飞书、知识、文档、RPA 和企业能力已通过插件接入且无核心边界违规。
- Legacy Runtime 已从生产执行路径移除，旧会话仍可读取或已完成可审计迁移。

在以上条件未全部满足前，产品描述应使用“DSH Runtime 预览”“部分 DSH 能力兼容”或明确的阶段性名称，不得宣称全量兼容。
