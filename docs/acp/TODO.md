# ACP 双向能力现代化改造 TODO

> **目标**：让 Otto 同时支持
> - 作为 **Agent** 被外部 GUI（Zed 等）调用
> - 作为 **Client** 调用外部 ACP Agent（Claude Code / 其他 easycode 实例 / 自定义 agent）
>
> **协议标准**：[Agent Client Protocol](https://agentclientprotocol.com/) 官方版（`@zed-industries/agent-client-protocol` npm 包）
>
> **决策记录**（用户已确认）：
> - ✅ 仅保留新版 ACP，移除 `0.0.9` 旧实现
> - ✅ Client 端触发方式：Slash 命令 + `settings.json` 配置
> - ✅ 外部 Agent 工具调用统一到现有 Tool 系统
> - ✅ Agent 端 + Client 端一起做
>
> **当前状态**：规划阶段 / 未开始编码

---

## 文档目录

- [阶段 0：前期准备](#阶段-0前期准备)
- [阶段 1：基础设施与协议层](#阶段-1基础设施与协议层)
- [阶段 2：Agent 端现代化](#阶段-2agent-端现代化作为被调用方)
- [阶段 3：Client 端新增实现](#阶段-3client-端新增实现作为调用方)
- [阶段 4：Tool 系统集成](#阶段-4tool-系统集成)
- [阶段 5：Slash 命令与配置](#阶段-5slash-命令与配置)
- [阶段 6：测试](#阶段-6测试)
- [阶段 7：文档与迁移](#阶段-7文档与迁移)
- [附录 A：协议方法映射表](#附录-a协议方法映射表)
- [附录 B：文件变更清单](#附录-b文件变更清单)
- [附录 C：风险登记](#附录-c风险登记)

---

## 阶段 0：前期准备

### 0.1 依赖调研与锁定
- [ ] 确认 `@zed-industries/agent-client-protocol` 最新稳定版本号
- [ ] 验证该包是否 ESM only / 是否支持 Node 20+
- [ ] 阅读包内 `AgentSideConnection` 和 `ClientSideConnection` 源码，确认 API 契约
- [ ] 检查包是否包含 Content-Length 分帧实现，或需要自行实现

### 0.2 现有代码审计（已完成 ✅）
- [x] 识别旧实现位置：`packages/cli/src/acp/acp.ts` (467 行)、`packages/cli/src/acp/acpPeer.ts` (719 行)
- [x] 识别入口：`packages/cli/src/gemini.tsx:833-834`
- [x] 识别 CLI 参数：`packages/cli/src/config/config.ts:191-194`（`--experimental-acp`）
- [x] 确认配置字段：`packages/core/src/config/config.ts` 的 `experimentalAcp` + `getExperimentalAcp()`

### 0.3 分支与提交策略
- [ ] 创建 feature 分支：`feat/acp-bidirectional`
- [ ] 约定提交粒度：按阶段切提交（阶段 1 一笔、阶段 2 一笔……）
- [ ] 每阶段完成后跑 `npm run build` 和单文件测试，通过才推

---

## 阶段 1：基础设施与协议层

### 1.1 新目录结构创建
- [ ] 创建目录骨架：
  ```
  packages/cli/src/acp/
  ├── agent/          # Agent 端（被调用）
  ├── client/         # Client 端（主动调用）
  ├── shared/         # 共享工具
  └── __tests__/      # 集成测试
  ```
- [ ] 保留 `packages/cli/src/acp/acp.ts` 和 `acpPeer.ts` 直到阶段 2 完成再删

### 1.2 依赖安装
- [ ] 在 `packages/cli/package.json` 添加 `@zed-industries/agent-client-protocol`
- [ ] 运行 `npm install`
- [ ] 验证 `npm run build` 能通过

### 1.3 共享工具层 (`acp/shared/`)
- [ ] `logger.ts` —— 封装 stderr 日志（防污染 stdout），从 `acpPeer.ts:44-46` 的 `console.log = console.error` 逻辑抽取
- [ ] `errors.ts` —— 把内部错误（`getErrorStatus`、`isNodeError`）映射到 ACP `RequestError`
- [ ] `types.ts` —— 共享类型别名（如 `SessionId`、从 `@google/genai` 到 ACP `ContentBlock` 的桥接类型）

### 1.4 Content-Length 帧处理
- [ ] 若官方 SDK 未内置，新增 `acp/shared/frame.ts`
  - [ ] 实现 `encodeFrame(payload: unknown): Uint8Array`
  - [ ] 实现 `decodeStream(stream: ReadableStream): AsyncIterable<unknown>`
  - [ ] 处理跨 chunk 边界的分帧
- [ ] 单元测试：覆盖部分帧、完整帧、多帧连续、乱码恢复

---

## 阶段 2：Agent 端现代化（作为被调用方）

### 2.1 入口替换
- [ ] 新建 `acp/agent/runAgent.ts`（替代 `runAcpPeer`）
  - [ ] 设置 stderr 日志重定向
  - [ ] 构造 `AgentSideConnection`，注入 `OttoAgent`
- [ ] 修改 `packages/cli/src/gemini.tsx:833`
  ```ts
  if (config.getExperimentalAcp()) {
    const { runAgent } = await import('./acp/agent/runAgent.js');
    return runAgent(config, settings);
  }
  ```
- [ ] CLI 参数 `--experimental-acp` 保留名称，但行为切换到新协议

### 2.2 Session 管理
- [ ] 新建 `acp/agent/sessionManager.ts`
  - [ ] `SessionManager` 类，管理 `Map<SessionId, Session>`
  - [ ] `Session` 结构：`{ chat: GeminiChat, cwd: string, abortController?: AbortController, capabilities: ClientCapabilities }`
  - [ ] `new(params)` → 创建 `GeminiChat` 实例，返回 sessionId
  - [ ] `get(id)`、`delete(id)`、`cancelAll()`
  - [ ] （可选）`load(id)` 支持 `session/load` 方法做会话恢复

### 2.3 OttoAgent 主类
- [ ] 新建 `acp/agent/OttoAgent.ts`（替代 `GeminiAgent`），实现官方 `Agent` 接口：
  - [ ] `initialize(params)` → 返回 `protocolVersion`、`agentCapabilities`、`authMethods`
    - [ ] 读取客户端 `clientCapabilities` 存到 SessionManager
    - [ ] 声明支持的 `promptCapabilities`：`image: true`、`audio: false`、`embeddedContext: true`
  - [ ] `authenticate(params)` → 复用 `USE_PROXY_AUTH`（Cheeth OA）逻辑
  - [ ] `newSession(params)` → 调 SessionManager，初始化 `GeminiChat`
  - [ ] `loadSession(params)` → 恢复会话（若不支持可返回 methodNotFound）
  - [ ] `prompt(params)` → **核心**：启动 prompt turn（见 2.4）
  - [ ] `cancel(params)` → 调用 session.abortController.abort()

### 2.4 Prompt 主循环重写
- [ ] 把 `acpPeer.ts:100-200` 的 `sendUserMessage` 逻辑迁移并改造：
  - [ ] 解析 `ContentBlock[]` → Gemini `Part[]`（新建 `contentMapper.ts`）
    - [ ] `text` → `{ text }`
    - [ ] `image` → `{ inlineData: { mimeType, data } }`
    - [ ] `resource_link` → 调 `fs/read_text_file`（若客户端支持）或本地 `fs.readFile`
    - [ ] `resource`（嵌入） → 直接取 `text` 字段
    - [ ] `audio` → 若客户端声明支持，否则报错
  - [ ] 保留原有的 gitignore 过滤、at-path 解析逻辑（从 `acpPeer.ts#resolveUserMessage` 搬）
  - [ ] 消费 `chat.sendMessageStream`，把每个 chunk 转成 `session/update` 通知：
    - [ ] 普通文本 → `{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }`
    - [ ] thought → `{ sessionUpdate: 'thought_chunk', content: {...} }`
    - [ ] tool call 开始 → `{ sessionUpdate: 'tool_call', toolCallId, ... }`
    - [ ] tool call 更新 → `{ sessionUpdate: 'tool_call_update', ... }`
  - [ ] 返回 `{ stopReason: 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' }`

### 2.5 Tool Call → session/update 映射
- [ ] 新建 `acp/agent/toolMapper.ts`
  - [ ] `toSessionUpdateToolCall(toolName, args, details)` —— 构造 `tool_call` 事件
  - [ ] 复用旧的 `toToolCallContent`、`toAcpToolCallConfirmation` 逻辑但改适配新字段：
    - [ ] `kind`：`read` / `edit` / `delete` / `move` / `search` / `execute` / `think` / `fetch` / `other`
    - [ ] `locations`：`[{ path, line? }]`
    - [ ] `content`：`[{ type: 'diff' | 'content' | 'terminal', ... }]`
  - [ ] `toolConfirmation → requestPermission` 映射
    - [ ] 生成 `PermissionOption[]`：`allow_once` / `allow_always` / `reject_once` / `reject_always`
    - [ ] 处理 outcome：`selected(optionId)` → 回传到内部 `ToolConfirmationOutcome`
    - [ ] 处理 `cancelled`（prompt turn 被取消）

### 2.6 旧代码删除
- [ ] 删除 `packages/cli/src/acp/acp.ts`
- [ ] 删除 `packages/cli/src/acp/acpPeer.ts`
- [ ] 全仓库搜索 `runAcpPeer`、`GeminiAgent`、`LATEST_PROTOCOL_VERSION.*0\.0\.9` 残留引用并清理
- [ ] 删除相关 import

---

## 阶段 3：Client 端新增实现（作为调用方）

### 3.1 连接层
- [ ] 新建 `acp/client/AgentConnection.ts`
  - [ ] 封装 `ClientSideConnection`（从 `@zed-industries/agent-client-protocol`）
  - [ ] 构造时接收 `{ stdin: Writable, stdout: Readable, capabilities: Client }`
  - [ ] 暴露高层方法：`initialize()` / `newSession()` / `prompt()` / `cancel()` / `authenticate()`
  - [ ] 处理反向调用注入（见 3.3 能力提供）

### 3.2 进程生命周期
- [ ] 新建 `acp/client/AgentProcessManager.ts`
  - [ ] `spawn(config: AgentConfig)` —— child_process.spawn 外部 agent
  - [ ] 监听 stderr 日志转发到 Otto debug channel
  - [ ] 崩溃检测 + 退出码上报
  - [ ] `dispose()` —— SIGTERM → 超时后 SIGKILL
  - [ ] 心跳/健康检查（可选，优先简单实现）
  - [ ] **不自动重启**（避免无限循环），只上报状态让用户决定

### 3.3 Client 能力提供（反向被 Agent 调用）
- [ ] 新建 `acp/client/capabilities/fsProvider.ts`
  - [ ] `fs/read_text_file` —— 复用 `packages/core/src/tools/read-file.ts` 的过滤逻辑
    - [ ] 尊重 `.gitignore` / `.easycode-userignore`
    - [ ] 校验路径在 session cwd 内，防目录穿越
  - [ ] `fs/write_text_file` —— 复用 `write-file.ts` + Hook 检查
    - [ ] 必须走 `PreToolUse` hook（安全边界）
- [ ] 新建 `acp/client/capabilities/terminalProvider.ts`（可选，默认关闭）
  - [ ] `terminal/create` / `terminal/output` / `terminal/wait_for_exit` / `terminal/kill` / `terminal/release`
  - [ ] 通过 settings 开关控制：`acpAgents.<name>.allowTerminal: true`
- [ ] 权限桥接 `acp/client/capabilities/permissionBridge.ts`
  - [ ] 收到外部 agent 的 `session/request_permission` → 在 Otto TUI 弹确认对话框
  - [ ] 复用现有 `PermissionDialog` 组件（`packages/cli/src/ui/components/`）
  - [ ] 把 Otto 的 outcome 映射回 `{ selected: { optionId } }` 或 `{ cancelled }`

### 3.4 session/update 消费
- [ ] 在 `AgentConnection` 注册 `sessionUpdate` 处理器
  - [ ] `agent_message_chunk` → 流式追加到 ExternalAgentTool 的 `streamingContentUpdater`
  - [ ] `thought_chunk` → 可选展示（灰色文本 / 折叠）
  - [ ] `plan` → 渲染嵌套 todo 展示
  - [ ] `tool_call` / `tool_call_update` → 在 Otto TUI 显示**嵌套** tool call（缩进一级）
  - [ ] `available_commands_update` → 记录外部 agent 支持的 slash 命令（可选）

---

## 阶段 4：Tool 系统集成

### 4.1 ExternalAgentTool
- [ ] 新建 `acp/client/ExternalAgentTool.ts`
  - [ ] `extends BaseTool<AgentToolParams, ToolResult>`
  - [ ] `name = 'agent_' + sanitize(agentName)`（例：`agent_claude_code`）
  - [ ] `displayName = 'Ask ${agentName}'`
  - [ ] `description` 从配置或 agent 的 `serverInfo` 获取
  - [ ] `schema`：`{ query: string, context?: string }`
  - [ ] `execute(params, signal)`：
    - [ ] 调用 `connection.newSession()` 或复用长连接 session
    - [ ] 发送 `prompt`，订阅 `sessionUpdate`
    - [ ] 通过 `streamingContentUpdater` 实时回传
    - [ ] 返回 `{ llmContent, returnDisplay }`（返回外部 agent 最终回答）
  - [ ] `shouldConfirmExecute` —— 首次使用某 agent 时提示用户确认

### 4.2 动态工具注册
- [ ] 新建 `acp/client/AgentRegistry.ts`
  - [ ] `connect(name)` → spawn + initialize + 注入 `ExternalAgentTool` 到 `ToolRegistry`
  - [ ] `disconnect(name)` → dispose + 从 `ToolRegistry` 注销
  - [ ] `list()` → 返回所有已连接 agent 状态
  - [ ] 单例模式，`getAgentRegistry(config)` 惰性初始化
- [ ] 在 `ToolRegistry`（`packages/core/src/tools/tool-registry.ts`）增加 `registerDynamicTool/unregisterDynamicTool` 方法（若不存在）

### 4.3 工具命名空间隔离
- [ ] 外部 agent 的 tool 使用前缀 `agent_<name>_`，避免和内部工具冲突
- [ ] 在 LLM 提示词里说明 `agent_*` 工具表示"委托给其他 agent"，帮助模型正确选用
- [ ] 考虑是否需要 `/agent use <name>` 模式下暂时**只暴露 agent_xxx**，隐藏其他工具（保留决策项）

---

## 阶段 5：Slash 命令与配置

### 5.1 配置 Schema
- [ ] 在 `packages/cli/src/config/settings.ts` 的 Settings 类型中新增 `acpAgents` 字段：
  ```ts
  acpAgents?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;        // spawn 启动超时 ms
    autoStart?: boolean;     // CLI 启动时自动连
    allowTerminal?: boolean; // 是否暴露 terminal 能力给该 agent
    description?: string;
  }>
  ```
- [ ] 支持 `${workspaceRoot}`、`${env:XXX}` 变量替换
- [ ] JSON Schema 更新（供 IDE 智能提示）

### 5.2 Slash 命令
在 `packages/cli/src/commands/` 新建 `agent.ts`：
- [ ] `/agent list` —— 显示配置 + 运行状态表格
- [ ] `/agent connect <name>` —— 启动并握手
- [ ] `/agent disconnect <name>` —— 清理
- [ ] `/agent status [<name>]` —— 详细状态（PID、uptime、消息数）
- [ ] `/agent restart <name>` —— 重启
- [ ] `/agent logs <name>` —— 打印最近 stderr 日志
- [ ] 注册到 `CommandService`

### 5.3 @ 语法支持（可选，阶段 3 后可做）
- [ ] 在输入处理（`packages/cli/src/ui/hooks/useCompletion.ts`）识别 `@<agent-name>:`
- [ ] 补全已连接的 agent 名字
- [ ] 按 Enter 后把整条消息作为 `agent_xxx` tool 的 `query` 执行

### 5.4 自动连接
- [ ] 启动时读 `autoStart: true` 的 agent，后台连接
- [ ] 失败不阻塞 CLI 启动，只打印警告

---

## 阶段 6：测试

### 6.1 单元测试
- [ ] `acp/shared/frame.test.ts` —— 分帧编解码
- [ ] `acp/shared/errors.test.ts` —— 错误映射
- [ ] `acp/agent/sessionManager.test.ts` —— session 生命周期
- [ ] `acp/agent/contentMapper.test.ts` —— ContentBlock ↔ Gemini Part
- [ ] `acp/agent/toolMapper.test.ts` —— tool call 事件转换
- [ ] `acp/client/AgentConnection.test.ts` —— mock stdin/stdout 测连接
- [ ] `acp/client/AgentRegistry.test.ts` —— 注册/注销

### 6.2 E2E 自闭环测试
- [ ] `acp/__tests__/loopback.test.ts`
  - [ ] 在测试中 spawn 一个 `easycode --experimental-acp` 子进程
  - [ ] 用 `ClientSideConnection` 连上去
  - [ ] 发起 prompt，验证 sessionUpdate 流和最终 stopReason
  - [ ] 测试 fs/read_text_file 反向调用

### 6.3 手动验收清单
- [ ] 用 Zed 连接 `easycode --experimental-acp`，跑完整对话 + 工具调用 + 权限确认
- [ ] 用 Otto 连接另一个 `easycode --experimental-acp` 实例（闭环）
- [ ] 用 Otto 连接 Claude Code（需确认 Claude Code 是否支持 ACP）
- [ ] 网络断开 / agent 崩溃恢复行为
- [ ] 大文件场景（读写 1MB+）
- [ ] 中文消息 / emoji 编码

### 6.4 性能检查
- [ ] 流式 chunk 延迟：首字节 < 500ms
- [ ] 并发 session：同时开 3 个 session 不串扰
- [ ] 内存占用：长对话后无明显泄漏（跑 100 轮对比 RSS）

---

## 阶段 7：文档与迁移

### 7.1 新增文档
- [ ] `docs/acp/README.md` —— 协议总览 + 架构图
- [ ] `docs/acp/as-agent.md` —— 作为 Agent 被调用指南（Zed 配置示例）
- [ ] `docs/acp/as-client.md` —— 配置和调用外部 Agent 指南
- [ ] `docs/acp/capabilities.md` —— 支持的能力清单 + 协议版本
- [ ] `docs/acp/troubleshooting.md` —— 常见问题（连接失败、权限问题）

### 7.2 迁移说明
- [ ] `docs/acp/migration-from-0.0.9.md`
  - [ ] 旧版协议不再支持，列出受影响的用户
  - [ ] 升级步骤
  - [ ] 临时降级方案（如必要可以保留一个 git tag 指向旧版）

### 7.3 README 更新
- [ ] `README.md` / `README_EN.md` 加 ACP 章节
- [ ] `docs/index.md` 索引更新

### 7.4 i18n
- [ ] Slash 命令的用户可见输出做国际化
- [ ] 错误提示做国际化

---

## 附录 A：协议方法映射表

### Agent 方法（外部 → Otto）

| 旧 (0.0.9) | 新 (官方标准) | 实现位置 |
|---|---|---|
| `initialize` | `initialize` | `OttoAgent.initialize` |
| `authenticate` | `authenticate` | `OttoAgent.authenticate` |
| — | `session/new` | `OttoAgent.newSession` |
| — | `session/load` | `OttoAgent.loadSession`（可选） |
| `sendUserMessage` | `session/prompt` | `OttoAgent.prompt` |
| `cancelSendMessage` | `session/cancel` | `OttoAgent.cancel` |

### Client 方法（Otto 反向调用外部 / 或作为 Client 被外部 agent 调用）

| 旧 (0.0.9) | 新 (官方标准) | 实现位置 |
|---|---|---|
| `streamAssistantMessageChunk` | `session/update` (agent_message_chunk) | `OttoAgent.prompt` emit |
| — | `session/update` (thought_chunk) | 同上 |
| `pushToolCall` + `updateToolCall` | `session/update` (tool_call / tool_call_update) | `toolMapper.ts` |
| `requestToolCallConfirmation` | `session/request_permission` | `toolMapper.ts` |
| — | `fs/read_text_file` | `fsProvider.ts` |
| — | `fs/write_text_file` | `fsProvider.ts` |
| — | `terminal/*` | `terminalProvider.ts`（可选） |

### 能力声明

**Agent Capabilities**（Otto 作为 Agent 声明）：
- `loadSession`: false（初版）
- `promptCapabilities.image`: true
- `promptCapabilities.audio`: false
- `promptCapabilities.embeddedContext`: true

**Client Capabilities**（Otto 作为 Client 声明，或接收 Agent 端的）：
- `fs.readTextFile`: true
- `fs.writeTextFile`: true
- `terminal`: 按配置开关

---

## 附录 B：文件变更清单

### 新增文件
```
packages/cli/src/acp/
├── agent/
│   ├── runAgent.ts
│   ├── OttoAgent.ts
│   ├── sessionManager.ts
│   ├── contentMapper.ts
│   └── toolMapper.ts
├── client/
│   ├── AgentConnection.ts
│   ├── AgentProcessManager.ts
│   ├── AgentRegistry.ts
│   ├── ExternalAgentTool.ts
│   └── capabilities/
│       ├── fsProvider.ts
│       ├── terminalProvider.ts
│       └── permissionBridge.ts
├── shared/
│   ├── logger.ts
│   ├── errors.ts
│   ├── types.ts
│   └── frame.ts (若需要)
└── __tests__/
    ├── loopback.test.ts
    └── fixtures/

packages/cli/src/commands/agent.ts
docs/acp/README.md
docs/acp/as-agent.md
docs/acp/as-client.md
docs/acp/capabilities.md
docs/acp/migration-from-0.0.9.md
docs/acp/troubleshooting.md
```

### 修改文件
- `packages/cli/package.json` —— 新增依赖
- `packages/cli/src/gemini.tsx:833` —— 入口切换
- `packages/cli/src/config/settings.ts` —— 新增 `acpAgents` Schema
- `packages/core/src/tools/tool-registry.ts` —— 动态注册 API（若缺失）
- `README.md` / `README_EN.md` / `docs/index.md`

### 删除文件
- `packages/cli/src/acp/acp.ts`
- `packages/cli/src/acp/acpPeer.ts`

---

## 附录 C：风险登记

| # | 风险 | 影响 | 缓解措施 |
|---|---|---|---|
| R1 | 官方 ACP 版本演进快，breaking change | 高 | 锁定版本 + 在 `package.json` 用 `~` 而非 `^`；封装 SDK 减少爆炸半径 |
| R2 | 外部 Agent 崩溃或 hang 导致 Otto UI 卡死 | 高 | 所有调用加超时；心跳检测；异步非阻塞；明确的 loading/error 状态 |
| R3 | 权限桥接漏洞：外部 Agent 绕过 Hook 写文件 | 严重（安全） | fsProvider 必须走 Hook 检查；不直接暴露 Node `fs` 句柄 |
| R4 | 嵌套 tool call 在 TUI 显示混乱 | 中 | 设计缩进层级规则；限制嵌套深度（最多 2 层）；溢出折叠 |
| R5 | 旧版用户升级后连不上 | 中 | 清晰的错误消息指引；migration 文档；保留一个 git tag 作为回滚点 |
| R6 | 大文件 / 大 token 在 JSON-RPC 上性能差 | 低 | 使用流式 chunk；fs 读取分段；必要时 base64 + 压缩（未来优化） |
| R7 | Windows 平台 stdio 管道编码问题 | 中 | 显式 UTF-8；测试 Windows Terminal + CMD + PowerShell 三种环境 |
| R8 | ToolRegistry 动态注册 API 可能不存在 | 中 | 阶段 4.2 先探查，若缺则补；注意并发安全 |
| R9 | 外部 Agent 的 `session/request_permission` 和 Otto 原生 permission UI 竞争 | 中 | 串行化：同一时刻只允许一个 permission 对话框；队列管理 |
| R10 | Client 端作为长连接时内存泄漏 | 中 | 明确生命周期；断开时清理所有 pending request；压测验证 |

---

## 进度追踪

**最后更新**：2026-05-10
**当前阶段**：阶段 0-4 完成（Agent 端基础设施与协议层、Agent 端现代化、命令移植已落地），Client 端（调用外部 Agent）尚未开始。

**阶段完成状态**：
- [x] 阶段 0：前期准备（分支、依赖 `@agentclientprotocol/sdk@^0.16.1`、`--acp` CLI 参数、目录骨架）
- [x] 阶段 1：基础设施与协议层（core 端新增 `Kind`、`constants`、`stdio`、`version`、`InvalidStreamError`、`refreshAuth` 扩参、`FileSystemService`、`AgentLoopContext`、`PolicyEngine` + `MessageBus` + `coreEvents`、`resumeChat` + `SessionSelector` + `convertSessionToClientHistory`、命令辅助 helpers）
- [x] 阶段 2：Agent 端现代化（入口切换到 `runAcpClient`，移除旧 `acp.ts` / `acpPeer.ts`，新建 `acpStdioTransport` / `acpRpcDispatcher` / `acpSessionManager` / `acpSession` / `acpFileSystemService` / `acpUtils` / `acpErrors`）
- [ ] 阶段 3：Client 端新增实现（尚未开始）
- [ ] 阶段 4：Tool 系统集成（ExternalAgentTool、AgentRegistry —— 尚未开始）
- [x] 阶段 5：Slash 命令与配置（移植 `/help` `/about` `/memory` `/init` `/restore` `/extensions` 共 6 个命令；extensions / restore 目前为 stub，等待后续能力补齐）
- [x] 阶段 6：测试（新增 `acpErrors.test.ts` / `acpUtils.test.ts` / `acpCommandHandler.test.ts` 共 18 个用例，全部通过）
- [ ] 阶段 7：文档与迁移（ACP 使用文档待补）

**下一步行动**：
1. 推进 Client 端（作为调用方）实现
2. 补齐 `PolicyEngine` 与 DeepCode `coreToolScheduler` 的真实联动
3. 补 `UserAccountManager` / `McpServerEnablementManager` / `performRestore` 的实际实现（目前返回 stub）
4. 使用 Zed / 其它 ACP 客户端做端到端联调
