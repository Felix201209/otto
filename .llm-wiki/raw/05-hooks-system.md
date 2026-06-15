# Easy Code — Hooks System Facts

> Auto-generated from codebase analysis on 2026-04-09. Immutable source document.

## Architecture: 5-Layer Pipeline

Location: `packages/core/src/hooks/` (~2,800+ lines)

```
HookSystem (Coordinator)
├── HookRegistry     → Layer 1: Configuration loading & validation
├── HookPlanner      → Layer 2: Matcher-based hook selection & execution plan
├── HookRunner       → Layer 3: Child process spawning & script execution
├── HookAggregator   → Layer 4: Event-specific result merging strategies
└── HookEventHandler → Layer 5: Event-specific firing methods & orchestration
```

All logic in `packages/core`, shared by CLI and VSCode plugin automatically.

## File Structure

| File | Role | Lines (approx) |
|------|------|----------------|
| `types.ts` | Enums, interfaces, output classes (11 event-specific I/O types) | ~450 |
| `hookRegistry.ts` | Loads hooks from config, validates, tracks source precedence | ~200 |
| `hookPlanner.ts` | Regex/exact matcher filtering, deduplication, plan creation | ~140 |
| `hookRunner.ts` | `child_process.spawn` with shell:true, timeout, exit codes | ~280 |
| `hookAggregator.ts` | Event-specific merge strategies | ~300 |
| `hookEventHandler.ts` | 11 fire*Event() methods, base input creation, logging | ~350 |
| `hookSystem.ts` | Coordinator wiring all 5 layers | ~90 |
| `hookTranslator.ts` | Bidirectional GenAI SDK ↔ stable Hook API translation | ~300 |
| `index.ts` | Re-exports | ~20 |

## 11 Hook Event Types

| # | Event | Category | Trigger | Key Use Case |
|---|-------|----------|---------|-------------|
| 1 | `BeforeTool` | Tool | Before tool execution | Permission checks, security gates |
| 2 | `AfterTool` | Tool | After tool execution | Audit logging, result modification |
| 3 | `BeforeAgent` | Prompt/LLM | Before prompt sent to LLM | Prompt engineering, context injection |
| 4 | `AfterAgent` | Prompt/LLM | After LLM response | Response validation |
| 5 | `BeforeModel` | Prompt/LLM | Before LLM API call | Parameter optimization |
| 6 | `AfterModel` | Prompt/LLM | After LLM API response | Response filtering, synthetic responses |
| 7 | `BeforeToolSelection` | Tool Selection | Before tool selection | RBAC, tool whitelisting |
| 8 | `SessionStart` | Session | Session init | Environment setup |
| 9 | `SessionEnd` | Session | Session cleanup | Resource cleanup |
| 10 | `PreCompress` | Other | Before context compression | Compression preparation |
| 11 | `Notification` | Other | Permission requests | Custom notification handling |

## Configuration

### File Locations (precedence high→low)
1. Project: `.easycode/settings.json`
2. Global: `~/.easycode-user/settings.json`
3. Extensions: Active extensions with hooks

### Format Example
```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "write_file|delete_file",
        "sequential": false,
        "hooks": [
          {
            "type": "command",
            "command": "bash .easycode/hooks/security-gate.sh",
            "timeout": 30000
          }
        ]
      }
    ]
  }
}
```

### Source Priority
Project (1) > User (2) > System (3) > Extensions (4)

## Hook I/O Protocol

- **Input**: JSON via stdin — `session_id`, `cwd`, `hook_event_name`, `timestamp`, plus event-specific fields
- **Output**: JSON via stdout — `decision`, `reason`, `continue`, `suppressOutput`, `systemMessage`, `hookSpecificOutput`
- **Exit codes**: 0=success, 1=warning (non-blocking), 2=blocking deny, others=failure (non-blocking)

## Aggregation Strategies

| Strategy | Events | Behavior |
|----------|--------|----------|
| OR-Decision | BeforeTool, AfterTool, BeforeAgent, AfterAgent, SessionStart | Any deny/block blocks; messages concatenated |
| Field Replacement | BeforeModel, AfterModel | Later hooks override earlier |
| Union | BeforeToolSelection | Union of allowed tools; NONE mode is most restrictive |

## Runner Process Model

- `spawn()` with `shell: true` for cross-platform
- JSON input via child process stdin
- SIGTERM timeout (default 60s) with SIGKILL fallback after 5s
- `$GEMINI_PROJECT_DIR` and `$CLAUDE_PROJECT_DIR` env variable expansion

## HookTranslator

Provides stable, version-independent `LLMRequest`/`LLMResponse` format.
Translates between GenAI SDK types and hook format.
`defaultHookTranslator` is singleton of `HookTranslatorGenAIv1`.

## Typed Output Classes

- `DefaultHookOutput` — base: `isBlockingDecision()`, `getAdditionalContext()`, `getBlockingError()`
- `BeforeToolHookOutput` — `permissionDecision` compatibility fields
- `BeforeModelHookOutput` — `getSyntheticResponse()`, `applyLLMRequestModifications()`
- `BeforeToolSelectionHookOutput` — `applyToolConfigModifications()`
- `AfterModelHookOutput` — `getModifiedResponse()`

## Active Integrations

- `packages/core/src/core/turn.ts` (lines 238-378): Fires `BeforeModel`, `BeforeToolSelection`, `AfterModel`
- `packages/core/src/core/coreToolScheduler.ts` (line 209, 243): Passes `hookEventHandler` to `ToolExecutionEngine`
- `packages/cli/src/ui/commands/hooksCommand.ts`: `/hooks` slash command opens documentation URL
