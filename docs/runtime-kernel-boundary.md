# Otto Runtime Kernel Boundary

> **Status**: Living document — update when kernel modules change.
> **Last updated**: 2026-07-22

## Purpose

This document defines the **minimal runtime kernel** — the set of modules that form the irreducible core of Otto's agent runtime. Everything outside this boundary is optional, replaceable, or UI-specific.

## Kernel Responsibilities

The kernel owns these lifecycle-critical concerns:

### 1. Turn Lifecycle & State Machine

- **File**: `packages/core/src/core/turn.ts`
- Defines `Turn` — the state machine for a single LLM round-trip (request → stream → tool calls → response).
- Enumerates `OttoEventType` (Content, ToolCallRequest, ToolCallResponse, ToolCallConfirmation, UserCancelled, Error, ChatCompressed, Thought, Reasoning, MaxSessionTurns, Finished, LoopDetected, TokenUsage).
- Carries structured error types (`OttoErrorEventValue`), tool call request/response shapes, and confirmation outcome enums.
- **Entry point**: The `Turn` class is instantiated by `client.ts` per user message.

### 2. State Transitions (Tool Execution)

- **File**: `packages/core/src/core/toolExecutionEngine.ts`
- Defines `EngineToolCall` — the canonical discriminated union for tool call lifecycle:
  `validating → scheduled → executing → (success | error | cancelled)`
  with a side path `awaiting_approval`.
- The `ToolExecutionEngine` class is the **single source of truth** for all pending tool calls.
- Provides `reset()` for state cleanup between turns.
- Supports runtime confirmation (`RuntimeConfirmationRequest`) during execution.

### 3. Tool Dispatch Boundary

- **File**: `packages/core/src/core/coreToolScheduler.ts`
- Bridges LLM function-call responses → tool execution via `convertToFunctionResponse()`.
- Handles approval-mode gating, editor-type selection, modifiable-tool diff flows.
- **File**: `packages/core/src/core/nonInteractiveToolExecutor.ts`
- `executeToolCall()` — single-tool executor for non-interactive (CLI `--yolo`) paths.
- **File**: `packages/core/src/core/toolSchedulerAdapter.ts`
- Defines `ToolSchedulerAdapter` — the **UI-decoupling interface**.
  All UI callbacks (`onToolStatusChanged`, `onOutputUpdate`, `onAllToolsComplete`, `onToolCallsUpdate`, `getPreferredEditor`, `onPreToolExecution`) flow through this adapter.
  `MainAgentAdapter` and `SubAgentAdapter` are concrete implementations.

### 4. Permission Checks

- **File**: `packages/core/src/core/confirmationBridge.ts`
- `ToolCallConfirmationDetails` and `ToolConfirmationOutcome` — the kernel-level contract for tool approval.
- The kernel does **not** render UI; it exposes the confirmation surface through `ToolSchedulerAdapter`.

### 5. Checkpoint Hooks

- **File**: `packages/core/src/core/logger.ts`
- `Logger.saveCheckpoint()` / `Logger.loadCheckpoint()` — persist conversation state to disk.
- Checkpoint files live in `~/.otto-user/` under `checkpoint-{tag}.json`.
- These are **synchronous snapshots** of `Content[]` at user-defined tags.

### 6. Audit Event Emission

- **File**: `packages/core/src/orchestration/auditLog.ts`
- `getAuditLogger()` — emits structured audit events for tool calls, model requests, and configuration changes.
- The audit logger is injected into `ToolExecutionEngine` and `OttoChat`.
- Audit log storage is in `~/.otto-user/audit/audit-*.jsonl`.

### 7. Model Routing (Scene Manager)

- **File**: `packages/core/src/core/sceneManager.ts`
- `SceneType` enum (11 scenes: CHAT_CONVERSATION, WEB_FETCH, WEB_SEARCH, etc.).
- `SCENE_MODEL_MAPPING` — maps each scene to a cost-appropriate model.
- `SceneManager.getModelForScene()` is the **single entry point** for model selection.

### 8. Content Generation Abstraction

- **File**: `packages/core/src/core/contentGenerator.ts`
- `ContentGenerator` interface — abstracts `generateContent`, `generateContentStream`, `countTokens`, `embedContent`.
- `createContentGenerator()` factory — wires up auth, proxy, and server adapter.

### 9. Token Limit Calculation

- **File**: `packages/core/src/core/tokenLimits.ts`
- `tokenLimit(model, config)` — the **single source of truth** for context-window math.
- Resolves: custom model → cloud model info → `AUTO_MODE_CONFIG` fallback (200K).

### 10. Chat Session Core

- **File**: `packages/core/src/core/ottoChat.ts`
- Forked from `@google/genai` `Chat` for correctness (function-response handling).
- Manages history accumulation, retry with backoff, compression triggers.

### 11. Prompt Construction

- **File**: `packages/core/src/core/prompts.ts`
- `getCoreSystemPrompt()` — assembles the system instruction from tools, skills, memory, hooks.
- Defines `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` for prompt-cache-aware splitting.

### 12. Request Wrapper

- **File**: `packages/core/src/core/ottoRequest.ts`
- `OttoCodeRequest` type alias for `PartListUnion` — the kernel's message shape.

### 13. Sub-Agent Lifecycle

- **File**: `packages/core/src/core/subAgent.ts`
- Spawns, manages, and collects results from sub-agents.
- Enforces timeout budgets (`TURN_TIMEOUT_MS`, `TOOL_COMPLETION_TIMEOUT_MS`).
- **File**: `packages/core/src/core/subAgentAdapter.ts`
- UI adapter for sub-agent tool execution (no-op logging, parent-agent forwarding).

### 14. Workflow System

- **File**: `packages/core/src/core/workflowRegistry.ts`
- Registers named workflow definitions (multi-step agent orchestration).
- **File**: `packages/core/src/core/workflowRunner.ts`
- Executes workflows with step validation and agent spawn delegation.
- **File**: `packages/core/src/core/workflowAgentBridge.ts`
- Bridges workflow steps → agent execution with context propagation.

---

## What Must NOT Live in the Kernel

These concerns belong outside the kernel boundary. Kernel files **must not import** from them.

### Provider Adapters

- OpenAI/Anthropic format adapters — these live in `packages/core/src/core/customModelAdapter.ts` (a *provider adapter*, not kernel logic) and `packages/core/src/utils/modelDiagnostics.ts`.
- **Test**: kernel files must not `import` from provider-specific paths.

### UI Behavior (React, Ink, DOM)

- `packages/cli/src/ui/` — Terminal UI (Ink/React 19)
- `packages/desktop/src/renderer/` — Electron DOM UI (React 18)
- `packages/vscode-ui-plugin/` — VS Code WebView
- **Ban**: `import from 'react'`, `import from 'ink'`, `import from '../ui/'`, `import from '../../desktop/'`.

### Memory Ranking / Scoring

- `packages/core/src/memory/` — Mem0 adapter, codebase memory, org memory.
- The kernel uses memory but does not rank or score; ranking logic is in `memoryProvider.ts`, `mem0Adapter.ts`.

### Document Workflows

- `packages/core/src/tools/convert-document.js`, `generate-document.js` — Office document generation.
- `packages/core/src/tools/ppt/` — PowerPoint tooling.
- These are tools called *by* the kernel, not part of it.

### Repo-Specific Integrations

- `packages/core/src/tools/desktop-automation.js` — OS-level automation.
- `packages/core/src/tools/web-automation.js` — Browser automation.
- `packages/core/src/orchestration/enterpriseSync.ts` — Feishu org sync.

### Experimental Orchestration

- `packages/core/src/orchestration/multiAgent.ts` — Multi-agent collaboration.
- `packages/core/src/orchestration/taskOrchestrator.ts` — LangGraph orchestration.
- `packages/core/src/orchestration/autoSkillGenerator.ts` — Skill auto-generation.

### Platform-Specific Code

- `packages/core/src/ide/` — IDE-specific context (VS Code workspace detection, lint integration).
- `packages/core/src/lsp/` — Language Server Protocol clients.
- **Ban**: kernel files must not import from `../ide/` or `../lsp/`.

---

## Kernel Entry Points (Exact File Paths)

These are the files that form the kernel boundary. Every file here lives under `packages/core/src/core/`:

| File | Role | Key Export(s) |
|---|---|---|
| `client.ts` | Top-level agent orchestration | `OttoClient` class |
| `turn.ts` | Single LLM round-trip state machine | `Turn`, `OttoEventType`, `ServerTool` |
| `toolExecutionEngine.ts` | Tool call lifecycle engine | `ToolExecutionEngine`, `EngineToolCall` and variants |
| `coreToolScheduler.ts` | LLM response → tool execution bridge | `convertToFunctionResponse` |
| `nonInteractiveToolExecutor.ts` | Non-interactive tool runner | `executeToolCall` |
| `toolSchedulerAdapter.ts` | UI-decoupling adapter interface | `ToolSchedulerAdapter`, `ToolExecutionContext`, `NoOpToolSchedulerAdapter` |
| `mainAgentAdapter.ts` | Main agent UI adapter | `MainAgentAdapter` |
| `subAgentAdapter.ts` | Sub-agent UI adapter | `SubAgentAdapter` |
| `confirmationBridge.ts` | Tool approval contract | `ToolCallConfirmationDetails`, `ToolConfirmationOutcome` |
| `logger.ts` | Conversation logging + checkpointing | `Logger`, `MessageSenderType`, `LogEntry` |
| `contentGenerator.ts` | Model API abstraction | `ContentGenerator`, `createContentGenerator`, `AuthType` |
| `sceneManager.ts` | Model routing by scene | `SceneType`, `SceneManager`, `SCENE_MODEL_MAPPING` |
| `prompts.ts` | System prompt construction | `getCoreSystemPrompt`, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` |
| `tokenLimits.ts` | Context window calculation | `tokenLimit` |
| `modelConfig.ts` | Model configuration | Model config types |
| `ottoChat.ts` | Chat session core (forked genai Chat) | `OttoChat` |
| `ottoRequest.ts` | Message shape type | `OttoCodeRequest` |
| `subAgent.ts` | Sub-agent lifecycle | `SubAgentExecutionContext`, `SubAgentResult` |
| `customModelAdapter.ts` | Custom model format adapter | `CustomModelAdapter` |
| `OttoServerAdapter.ts` | Server API adapter | `OttoServerAdapter` |
| `imageGenerator.ts` | Image generation dispatch | Image generator |
| `workflowRegistry.ts` | Workflow definitions | `WorkflowRegistry` |
| `workflowRunner.ts` | Workflow execution | `WorkflowRunner` |
| `workflowAgentBridge.ts` | Workflow → agent bridge | `WorkflowAgentBridge` |
| `taskPrompts.ts` | Sub-agent task prompt templates | `TaskPrompts` |
| `proxyAuth.ts` | Proxy authentication | Proxy auth utilities |
| `modelCheck.ts` | Model capability checks | Model check utilities |
| `invalidStreamError.ts` | Stream error type | `InvalidStreamError` |
| `fixRequestContents.test.ts` | Request sanitization tests | Test helpers |
| `sanitizeRequestContents.test.ts` | Request sanitization | Sanitize utilities |

Supporting kernel-side modules that are **part of the kernel boundary** but not in `core/`:

| File | Role | Why kernel? |
|---|---|---|
| `orchestration/auditLog.ts` | Audit event emission | Injected into `ToolExecutionEngine` |
| `orchestration/workLog.ts` | Work log auto-recording | Injected into `ToolExecutionEngine` |
| `orchestration/skillShare.ts` | Skill sharing | Injected into `ToolExecutionEngine` |
| `hooks/hookEventHandler.ts` | Hook lifecycle | Injected into `ToolExecutionEngine` via `HookEventHandler` |

---

## Import Boundary Rules

```
✅ Kernel files MAY import from:
   - Other kernel files (../core/*)
   - Shared types (../types/*)
   - Config (../config/*)
   - Utils (../utils/*) — with caution: no UI, no platform-specific
   - Services (../services/*) — session, compression, file operations
   - @google/genai (the LLM SDK)

❌ Kernel files MUST NOT import from:
   - 'react', 'ink', 'electron'
   - '../ui/' (any UI directory)
   - '../../desktop/' (desktop package)
   - '../../cli/' (CLI package)
   - '../../server/' (server package)
   - '../lsp/' (LSP-specific — not kernel)

⚠️  Tolerated (current state, may be refactored later):
   - '../ide/'  — client.ts imports ideContext for IDE-mode file context injection;
     this is context-gathering (not rendering), so it's not a violation today
```

---

## Testing the Boundary

A lightweight test at `packages/core/src/core/kernelBoundary.test.ts` verifies that kernel source files contain no banned imports. The test reads source text directly — no runtime dependency graph needed. See that file for details.
