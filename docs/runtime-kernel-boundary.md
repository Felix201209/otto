# Otto Runtime Kernel Boundary

> **Status**: Living document — update when kernel modules change.
> **Last updated**: 2026-07-26 (updated for A2A protocol and optional video editor boundaries)

## Purpose

This document defines the **minimal runtime kernel** — the set of modules that form the irreducible core of Otto's agent runtime. Everything outside this boundary is optional, replaceable, or UI-specific.

## Kernel Responsibilities

The kernel owns these lifecycle-critical concerns:

### 1. Turn Lifecycle & State Machine

- **File**: `packages/core/src/core/turn.ts`
- Defines `Turn` — the state machine for a single LLM round-trip (request → stream → tool calls → response).
- Enumerates `OttoEventType` (Content, ToolCallRequest, ToolCallResponse, ToolCallConfirmation, UserCancelled, Error, ChatCompressed, Thought, Reasoning, MemoryContext, MaxSessionTurns, Finished, LoopDetected, TokenUsage).
- Carries structured error types (`OttoErrorEventValue`), tool call request/response shapes, and confirmation outcome enums.
- **Entry point**: The `Turn` class is instantiated by `client.ts` per user message.
- **File**: `packages/core/src/core/turnStateMachine.ts` — deterministic turn state model
  - Defines `TurnState` enum: `created → planning → (awaiting_permission | executing_tool) → observing_result → writing_memory → checkpointing → (completed | failed | cancelled)`.
  - `TurnStateMachine` class enforces valid transitions at runtime via `transition()`, throwing `InvalidTransitionError` on invalid moves.
  - `isTerminal()` identifies completed/failed/cancelled as terminal states.
  - `describeTransition(from, to)` helper for audit logging.
  - The `Turn` class accepts an optional `TurnStateMachine` via constructor injection and calls `safeTransition()` at key lifecycle points (turn start, tool execution, completion, error, cancellation). This is opt-in and non-breaking — callers without a state machine continue to work unchanged.

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

- **File**: `packages/core/src/tools/toolStatusSummary.ts`
- Owns deterministic, user-visible summaries for tool and tool-group status.
- Rule: UI surfaces may localize or style these summaries, but must not reimplement tool-result parsing rules independently.

### 3a. Tool Registry Load Boundary

- **File**: `packages/core/src/config/config.ts`
- `Config.createToolRegistry()` owns default tool registration, but optional heavy tools must stay behind dynamic imports.
- Heavy optional tools include PPT generation, document conversion/generation, data analysis, desktop/web automation, multi-channel integrations, enterprise collaboration, and voice bridge.
- Rule: when a tool is only useful for a specialized workflow or requires large optional runtime dependencies, do not add a static import in `config.ts`; register it with the lazy registration helper after `coreTools` / `excludeTools` filtering.
- Rule: low-resource agent profiles should prefer explicit `coreTools` allow-lists so excluded lazy tools are never imported.

### 3b. Component Manifest Boundary

- **File**: `packages/core/src/components/componentManifest.ts`
- Defines the versioned manifest contract for external tools, connectors, runtimes, agent profiles, themes, and GUI shells.
- Organization/vendor components must not claim kernel-owned paths. Kernel updates should remain upstream-owned; organization-specific behavior belongs in components.
- **File**: `packages/core/src/kernel/kernelDistributionManifest.ts`
- Defines the signed compiled-kernel distribution contract for enterprise/private deployments.
- Rule: locked enterprise kernels must be source-free compiled artifacts with SHA-256 integrity, detached signature, signing-key identity, component API version, and performance budget.
- Rule: describe the guarantee as tamper-evident and reverse-engineering resistant; never promise that local software is impossible to inspect or crack.
- **Architecture guide**: `docs/enterprise-component-architecture.md`

### 3c. Product UX Contract

- **File**: `packages/core/src/ux/agentExperienceContract.ts`
- Defines stable product semantics for tool readiness, agent activity labels, and unread-dot behavior.
- Rule: performance optimizations may change load timing and sub-agent profiles, but must not make user-facing tools feel missing or first-use slow after session setup.
- **UX guide**: `docs/product-ux-contracts.md`

### 3d. Shared Product Protocols

- **File**: `packages/core/src/a2a/atoaProtocol.ts`
- Defines the typed A2A message prefixes, payloads, parsing, rendering helpers, and context-source constants shared by desktop and enterprise tests.
- Rule: desktop and server code must consume A2A protocol types/constants through this shared module or public package exports; server must not import `packages/desktop/src`.
- Rule: this module is pure protocol/data logic only. It must not import Electron, HTTP server code, UI components, storage, or provider adapters.

### 4. Central Policy Gate

- **File**: `packages/core/src/policy/centralPolicy.ts`
- `CentralPolicy.canExecute(toolName, context)` — the **single policy decision point** for all risky behavior.
- Wraps `PolicyEngine` (approval-mode gating), feature flags (from project config), and audit logging.
- Deny-by-default: missing config or disabled flag → `PolicyDecision.Deny`.
- Injected into `ToolExecutionEngine` and called **before** any tool validation or execution.
- **File**: `packages/core/src/policy/policy-engine.ts`
- `PolicyEngine` — in-memory session policy engine (allow/deny/ask-user).
- **File**: `packages/core/src/policy/policy-updater.ts`
- `createPolicyUpdater` / `updatePolicy` — persist "always allow" decisions via the MessageBus.

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

- **File**: `packages/core/src/core/agentResourceBudget.ts`
- Defines the device-aware resource budget for direct task agents and workflow agents.
- Defaults are conservative: low-profile devices run one direct task agent and two workflow agents; high-profile devices still default to four workflow agents, not unlimited fan-out.
- Includes `subAgentHistoryMaxChars` so long-running agents have a character-level history ceiling in addition to token compression.
- Supported overrides:
  - `OTTO_AGENT_PROFILE=low|standard|high`
  - `OTTO_TASK_MAX_CONCURRENCY`
  - `OTTO_WORKFLOW_MAX_CONCURRENCY`
  - `OTTO_WORKFLOW_MAX_AGENTS`
  - `OTTO_WORKFLOW_CONTEXT_MAX_CHARS`
  - `OTTO_SUBAGENT_HISTORY_MAX_CHARS`
  - `OTTO_SUBAGENT_TIMEOUT_MS`
- Rule: new multi-agent features must consume this budget helper instead of inventing local constants.
- **File**: `packages/core/src/core/agentMemoryStats.ts`
- Builds lightweight per-agent memory footprint reports from process snapshots.
- Reports RSS/heap deltas, retained history size, retained history message count, pending tool result parts, and elapsed time.
- Rule: sub-agent UIs and workflow callers may display or aggregate these reports, but must not retain raw histories just to compute memory stats.
- **File**: `packages/core/src/core/subAgent.ts`
- Spawns, manages, and collects results from sub-agents.
- Enforces timeout budgets (`TURN_TIMEOUT_MS`, `TOOL_COMPLETION_TIMEOUT_MS`).
- Emits `memoryUsage` in `SubAgentResult` and enforces the history character budget after compression attempts.
- **File**: `packages/core/src/agents/agentDefinition.ts`
- Owns built-in sub-agent tool profiles.
- Rule: the default `code-analysis` sub-agent must stay on the lightweight read-only analysis toolset (`list_directory`, `glob`, `search_file_content`, `read_file`, `read_many_files`, `lsp`, `codesearch`) instead of wildcard inheritance.
- Rule: user-facing main-agent tools remain fully registered and instant after registry creation; full sub-agent access must be an explicit agent type such as `workflow-orchestrator`, not the default.
- **File**: `packages/core/src/core/subAgentAdapter.ts`
- UI adapter for sub-agent tool execution (no-op logging, parent-agent forwarding).

### 14. Workflow System

- **File**: `packages/core/src/core/workflowRegistry.ts`
- Registers named workflow definitions (multi-step agent orchestration).
- **File**: `packages/core/src/core/workflowRunner.ts`
- Executes workflows with step validation and agent spawn delegation.
- **File**: `packages/core/src/core/workflowAgentBridge.ts`
- Bridges workflow steps → agent execution with context propagation.

### 15. Memory Subsystem

- **File**: `packages/core/src/memory/memorySubsystem.ts`
- `MemorySubsystem` interface — unified API for capture, search, stats, rebuild, clear.
- `createMemorySubsystem(opts)` — factory that wraps autoMerge + knowledgeCapture + localKnowledgeStore.
  - `capture(event: MemoryEvent)` — record a memory-worthy event with source provenance.
  - `search(query, opts?)` — simple substring FTS, zero external deps, returns `MemorySearchResult[]` with provenance.
  - `getStats()` — `MemoryStats` with autoMerge/knowledgeEntries breakdown + lastUpdated.
  - `rebuild()` — rescan global.md + entries.jsonl, rerun maintenance cycle.
  - `clear()` — wipe in-memory event list (does not delete source files).
- **Disabled mode**: `{ disabled: true }` makes all ops no-ops — kernel can disable memory via config flag.
- **Types**: `MemoryEvent`, `MemorySearchResult`, `SearchOptions`, `MemoryStats`.
- The kernel calls `capture()` after significant turns and `search()` when context retrieval is needed.
- Search is intentionally simple (substring + scoring) — no external vector DB or embedding API required.

### 16. Session Memory Injection

- **File**: `packages/core/src/memory/sessionMemoryInjector.ts`
- `SessionMemoryInjector` class — automatic memory context injection on new session.
  - `inject(sessionId, userMessage)` — searches MemorySubsystem for relevant entries based on keyword extraction from user message.
  - Uses simple keyword extraction (word splitting + stop-word filtering).
  - Returns `MemoryInjection`: { entries, summary, tokenCount, totalFound, projectCount, globalCount }.
  - Time-decay weighting: older entries scored lower via half-life model (14-day half-life).
  - Budget enforcement: max 5 entries, total < 500 tokens.
  - Project-scope vs global-scope differentiation via heuristic (tags, path patterns).
- Wired into `OttoClient.sendMessageStream()` — on first turn (`sessionTurnCount === 1`), the injector searches memory and prepends the summary to the user message context.
- Emits `OttoEventType.MemoryContext` before the model call so UI surfaces can show "found N related memories" instead of hiding the behavior in logs.
- The injection is fail-safe: failures are caught and logged without interrupting the turn.
- **Types**: `MemoryInjection`.

---

## What Must NOT Live in the Kernel

These concerns belong outside the kernel boundary. Kernel files **must not import** from them.

### Optional External Components

- Desktop-only optional tools such as the OpenReel video editor remain outside the kernel.
- The desktop package does not bundle `resources/video-editor` by default. Packaged builds must fail loudly when the optional component is absent instead of falling back to a development server.
- Development builds may still use local repo resources or a local dev server to keep contributor workflow intact.

### Provider Adapters

- OpenAI/Anthropic format adapters — these live in `packages/core/src/core/customModelAdapter.ts` (a *provider adapter*, not kernel logic) and `packages/core/src/utils/modelDiagnostics.ts`.
- **Test**: kernel files must not `import` from provider-specific paths.

### UI Behavior (React, Ink, DOM)

- `packages/desktop/src/renderer/` — Electron DOM UI (React 18)
- 历史 VS Code WebView 包已移除；桌面 UI 统一在 `packages/desktop/renderer`。
- **Ban**: `import from 'react'`, `import from '../../desktop/'`.

### Memory Ranking / Scoring

- `packages/core/src/memory/` — Mem0 adapter, codebase memory, org memory, autoMerge engine.
- The kernel calls `MemorySubsystem` for capture/search; ranking/scoring/memory internals (autoMerge merge/split/compress, knowledgeCapture pipeline, mem0Adapter) are **not kernel code** — they live behind the `MemorySubsystem` interface.

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
| `policy/centralPolicy.ts` | Single policy decision point (feature flags + approval + audit) | Injected into `ToolExecutionEngine` as the first gate |
| `policy/policy-engine.ts` | In-memory session policy engine | Used by `CentralPolicy` for approval-mode gating |
| `policy/policy-updater.ts` | Persist "always allow" decisions | Used by ACP layer to update persistent policy |
| `orchestration/auditLog.ts` | Audit event emission | Injected into `CentralPolicy` and `ToolExecutionEngine` |
| `orchestration/workLog.ts` | Work log auto-recording | Injected into `ToolExecutionEngine` |
| `orchestration/skillShare.ts` | Skill sharing | Injected into `ToolExecutionEngine` |
| `hooks/hookEventHandler.ts` | Hook lifecycle | Injected into `ToolExecutionEngine` via `HookEventHandler` |
| `memory/sessionMemoryInjector.ts` | Session memory injection on session start | Called by `OttoClient.sendMessageStream()` on first turn |

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
