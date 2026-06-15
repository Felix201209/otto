---
type: entity
date: 2026-06-02
tags: [workflow, subagent, orchestration, multi-agent, token-budget]
sources: [core/src/core/workflowRunner.ts, core/src/core/workflowAgentBridge.ts, core/src/core/workflowRegistry.ts, core/src/tools/workflow.ts]
---

# Dynamic Workflow System

> JavaScript 编排脚本驱动的多 Agent 并发框架，参考 Claude Code workflow 设计，API 与 Claude Code 保持一致。

## 架构概览

```
用户输入 "workflow <任务>"
    │
    ▼
主 Agent (GeminiChat)
    │  调用 workflow 工具，生成 JS 编排脚本
    ▼
WorkflowTool.execute()
    │  解析 meta、注册 WorkflowRegistry
    ▼
runWorkflowScript()  ← vm sandbox (Node.js)
    │  执行 JS 脚本，注入 agent / phase API
    ▼
WorkflowAgentBridge
    │  agent.run() / agent.runParallel()
    ▼
SubAgent × N         ← 独立上下文、独立工具执行引擎
    │  返回 summary / data
    ▼
orchestrator 脚本汇总，return 最终结果
    │
    ▼
WorkflowTool 返回结果给主 Agent
```

## 核心文件

| 文件 | 职责 |
|------|------|
| `core/src/tools/workflow.ts` | 工具入口，参数校验，调用 runWorkflowScript |
| `core/src/core/workflowRunner.ts` | vm sandbox 执行，transpile ES module → CJS，phase/agent API 注入 |
| `core/src/core/workflowAgentBridge.ts` | WorkflowAgentAPI 实现，buildPrompt，SubAgent 生命周期管理 |
| `core/src/core/workflowRegistry.ts` | 内存状态存储，供 WorkflowPanel UI 订阅 |
| `packages/cli/src/ui/components/WorkflowPanel.tsx` | 终端 UI，实时展示 phases/agents/token |

## 脚本 API（与 Claude Code 完全一致）

```javascript
export const meta = {
  name: 'workflow-slug',
  description: '简短描述',
  phases: [
    { title: '收集', detail: '收集代码信息' },
    { title: '分析', detail: '分析结果' },
  ],
};

phase('收集');  // 更新 UI 阶段指示器

const result = await agent('prompt text', {
  label: 'UI 显示标签',
  schema: { type: 'object', properties: { ... }, required: [...] },
  model: 'gemini-2.0-flash',    // 可覆盖模型
  context: previousResult,      // 传递上游结果
  max_turns: 15,
});

// 并发执行
const [r1, r2] = await agent.runParallel([
  { prompt: 'task A', label: 'A' },
  { prompt: 'task B', label: 'B' },
]);

export default async function(agent) {
  // 编排逻辑
}
```

## 触发方式与魔法词门控

### 触发规则
用户在聊天框输入以 `workflow ` 开头的**任务描述**（非问句），系统提示词中有 MANDATORY 规则强制主 Agent 调用 workflow 工具，不走内联回答。

### 三层防御机制（防止 AI 自发调用）

背景：AI 看到工具描述后可能在语义上判断"这个任务适合用 workflow"而自发调用，尤其是 `/goal` 长程任务模式下。为此实现了三层防御：

**层 1 — 工具描述约束（`workflow.ts`）**

工具 description 明确写明：
```
ONLY invoke this tool when the user's message contains the exact word "workflow".
Do NOT invoke for /goal, task planning, or any other purpose — even if the task seems large or complex.
```

**层 2 — System prompt 约束（`prompts.ts`）**

4 处 workflow 工具引用均使用统一措辞：
```
Only use '${WorkflowTool.Name}' when the user's message contains the exact word "workflow".
Do NOT invoke based on task complexity or scale.
```

**层 3 — per-request 硬过滤（`geminiChat.ts`，核心）**

`filterToolsByMessage()` 函数在每次请求组装 payload 时执行过滤：
- 检测当前用户消息是否包含 `\bworkflow\b`（case-insensitive）
- 不含魔法词时，从本次请求的 `tools` 列表中**移除 WorkflowTool**
- 仅覆盖单次请求的 `config.tools`，不修改 `generationConfig` 持久状态
- 流式（`sendMessageStream`）和非流式（`sendMessage`）两条路径均已接入

```typescript
// packages/core/src/core/geminiChat.ts（文件末尾）
function filterToolsByMessage(userContent: Content, tools: unknown): unknown {
  const userText = ...; // 提取当前用户消息文本
  const hasWorkflowTrigger = /\bworkflow\b/i.test(userText);
  if (hasWorkflowTrigger) return tools;
  // 过滤掉 WorkflowTool.Name
}
```

**效果**：历史上下文中无论存在多少 workflow 调用记录，均无法绕过第 3 层。AI 在当前轮看不到工具，就无法调用。

### 如何为其他工具添加魔法词门控

若未来需要对其他工具实施类似的"魔法词触发"保护，参考以下步骤：

1. **修改工具 description**（`packages/core/src/tools/<tool>.ts`）：
   ```
   ONLY invoke this tool when the user's message contains the exact word "<magic-word>".
   Do NOT invoke based on task complexity or any other condition.
   ```

2. **修改 system prompt**（`packages/core/src/core/prompts.ts`），找到所有引用该工具的位置，统一改为魔法词唯一触发规则。

3. **扩展 `filterToolsByMessage`**（`packages/core/src/core/geminiChat.ts`）：
   ```typescript
   function filterToolsByMessage(userContent: Content, tools: unknown): unknown {
     const userText = ...;

     // 现有：workflow 门控
     const hasWorkflowTrigger = /\bworkflow\b/i.test(userText);

     // 新增：其他工具门控
     // const hasXxxTrigger = /\bxxx\b/i.test(userText);

     return (tools as Tool[]).map(toolGroup => {
       const filtered = toolGroup.functionDeclarations?.filter(decl => {
         if (decl.name === WorkflowTool.Name && !hasWorkflowTrigger) return false;
         // if (decl.name === XxxTool.Name && !hasXxxTrigger) return false;
         return true;
       });
       return { ...toolGroup, functionDeclarations: filtered };
     });
   }
   ```

4. **补充测试**（`geminiChat.test.ts`）：在 `filterToolsByMessage (workflow gate)` describe 块中按现有用例格式添加新工具的测试。

## 关键参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `max_concurrency` | 6 | 最大并发 sub-agent 数 |
| `max_agents` | 1000 | 单次 workflow 最大 agent 总数（硬限制） |
| `max_turns` (per agent) | 15 | 每个 sub-agent 最大对话轮数 |
| `DEFAULT_AGENT_TIMEOUT_MS` | 30min | 单个 agent 运行超时（软警告，不强制中断） |
| context 截断上限 | 20,000 chars | 上游 context 超过此值自动截断，防止 prompt 爆炸 |

## 超时保护链路

| 层级 | 超时值 | 位置 | 触发场景 |
|------|--------|------|----------|
| stream fetch 连接层 | 300s | `EasyCodeServerAdapter.executeStreamAPICall` | 服务端接受请求但迟迟不发响应头 |
| stream per-chunk | 300s | `createStreamGenerator` | 流建立后 chunk 间隔超时 |
| 工具回调等待 | 10min | `SubAgent.processAndStorePendingToolResults` | shell/工具调用挂起，回调永不返回 |
| 单 agent 整体 | 30min (soft) | `WorkflowAgentBridge.run` warningTimer | 复杂任务运行过长，仅打印警告 |

## Agent 状态可视化

WorkflowPanel 中每个 agent 的状态行实时显示：
- `… Thinking · N tool calls · Xm Ys` — AI 正在推理
- `… Executing tools · N tool calls · Xm Ys` — 工具执行中

状态切换由 `WorkflowRegistry.updateAgentPhase()` 驱动：
- token 更新时 → `thinking`
- 工具调用时 → `executing_tools`（由 `updateAgentToolCall` 自动设置）

## result.data 规范

`agent.run()` 返回 `{ success, result, data }`：

- `data`：自动从 `result`（文本）中解析 JSON。**永远不会是 `undefined`**。
- 解析成功：`data` 为 JSON 对象
- 解析失败：`data = { text: result, _parse_failed: true }`
- 脚本里可用 `result.data._parse_failed` 判断是否解析失败，fallback 到 `result.result` 读原始文本

## 常见坑

### 1. 上下文爆炸（已修复）
**现象**：sub-agent 把读取的原始文件内容作为 context 传给下一个 agent，导致 prompt 达到 3000+ 行。
**修复**：`buildPrompt` 中 context 超过 20k chars 自动截断并打印 warning。
**根本预防**：每个 agent 的 prompt 应明确要求"返回 JSON 摘要，不返回原始文件内容"；workflow 工具描述中已加 CRITICAL 说明。

### 2. 脚本 JS 错误丢失 agent 输出（已修复）
**现象**：5 个 agent 全部跑完，orchestrator 脚本访问 `result.data.markdown_report`（不存在的字段），TypeError 崩溃，整个 workflow 被标记 failed，所有输出丢失。
**修复**：`runWorkflowScript` catch 块中把 `capturedLogs` 保留在 error 信息里；`result.data` 不再是 undefined。

### 3. 模型 fallback（部分修复）
**现象**：workflow 失败后，主 Agent 说"直接分析，跳过 workflow"，自行完成任务，用户无感知。
**修复**：workflow 失败的 `llmContent` 里加了"Do NOT attempt this task manually"。
**局限**：弱模型（Gemini-3.5-Flash）可能仍然不遵守，这是模型能力问题。

### 4. Thinking 卡死
**现象**：agent 显示 "Thinking · 18m 41s"，无工具调用，无输出。
**根因**：`sendMessage`（非流式）在服务端处理慢时 `response.json()` 永久挂起。
**修复**：`callGemini` 改为 `sendMessageStream`（流式），首 chunk 到达即开始处理。

---

## 待实现功能（Backlog）

### P1：Token 预算（`max_tokens` 参数）

**背景**：Claude Code 的 `task_budget` 功能（beta header `task-budgets-2026-03-13`）允许为整个 agentic loop 设置 advisory token 预算。我们可以在不依赖 Anthropic API 的情况下，自行实现等效能力。

**设计方案**：

在 `WorkflowToolParams` 加 `max_tokens?: number` 参数：

```typescript
// workflow 工具参数
max_tokens?: number;  // advisory token budget for the entire workflow
```

实现逻辑：

1. **`WorkflowAgentBridge`**：每次 `run()` 前检查 `tokenAccumulator.totalTokens`，若已超过 `max_tokens`，抛出 `WorkflowBudgetExceededError`，停止派发新 agent
2. **接近预算时提示 sub-agent 收尾**：当已用 token > `max_tokens * 0.8` 时，在 sub-agent prompt 末尾追加：
   ```
   [Token budget advisory: ~20% remaining. Please summarize findings concisely and avoid spawning additional tool calls.]
   ```
3. **UI 展示**：WorkflowPanel 显示 `已用 / 预算` token 进度条

**Advisory vs Hard 的取舍**：与 Claude Code 一致，采用 advisory 而非强制截断。原因：强制截断可能在 agent 执行关键写操作中途停止，造成文件损坏。

**最低预算门槛**：建议 20,000 tokens（与 Anthropic 一致）。

**参考**：Anthropic API `output_config.task_budget = { type: "tokens", total: N }`，beta header `task-budgets-2026-03-13`。

---

### P2：Micro Compact（工具历史清理）

**背景**：Claude Code 的 micro compact 在上下文接近阈值时，清除历史中**已完成的 function call + function response 对**，只保留文本轮次。无损、零 AI 调用成本，比现有的整体压缩（需调用 AI）成本低得多。

**现状问题**：SubAgent 的 `CompressionService` 只有重型压缩（调用 AI 生成摘要），工具调用记录占用大量 token，是今天看到 401k token SubAgent 的主要原因之一。

**设计方案**：

在 `CompressionService` 新增 `microCompact(history: Content[]): Content[]` 方法：

```typescript
// 伪代码
microCompact(history: Content[]): Content[] {
  // 保留环境消息（前 skipEnvironmentMessages 条）
  // 扫描其余历史，把已配对的 functionCall + functionResponse 对替换为单行文本摘要
  // 保留所有纯文本轮次（user/model 的 text parts）
  // 保留最近 N 轮的工具调用（避免 AI 失去当前操作上下文）
}
```

在 `tryCompress` 流程中插入：
```
shouldCompress() → true
    ↓
microCompact()   ← 新增，零 AI 成本
    ↓
shouldCompress() → 仍超阈值？
    ↓ 是
compressHistory() ← 原有重型压缩
```

**影响范围**：`CompressionService` 被主对话和 SubAgent 共用，加入后两处均受益。

**注意事项**：
- 需保证 micro compact 后历史仍满足 `validateAndCleanHistory` 和 `ensureAlternatingRoles` 约束
- 保留最近 2-3 轮工具调用，避免 AI 失去"我刚才做了什么"的短期记忆
- 可配置化：`microCompactKeepRecentToolTurns: number`（默认 2）

---

### P3：自定义 Agent 定义文件夹（`.easycode/agents/`）

**背景**：Claude Code 支持在 `.claude/agents/*.md` 里用 YAML frontmatter 定义可复用的专属 sub-agent，在 workflow 脚本中通过 `agent_type: 'my-agent-name'` 引用。

**现状**：我们的 `agent_type` 只支持少量固定枚举值（`code-analysis`、`code-reviewer` 等），用户无法针对项目定制专属 agent。

**优先级**：P3，实际使用频率较低。大多数用户更倾向于在 prompt 里直接描述任务需求。

---

## 测试覆盖

| 测试文件 | 覆盖内容 |
|----------|---------|
| `core/src/core/workflowRunner.test.ts` | extractMeta、runWorkflowScript 成功/失败路径、partial output 保留、abort 传播 |
| `core/src/core/workflowAgentBridge.test.ts` | buildPrompt 截断、result.data fallback、max_agents 限制、runParallel 并发 |
| `core/src/core/subAgent.toolTimeout.test.ts` | toolCompletionPromise 10min 超时、stream fetch 300s 超时 |
