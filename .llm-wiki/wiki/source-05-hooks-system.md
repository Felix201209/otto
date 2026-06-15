---
type: source-summary
date: 2026-04-09
tags: [hooks, lifecycle, events, security, extensibility]
source: raw/05-hooks-system.md
---

# Source Summary: Hooks System

> Summary of [raw/05-hooks-system.md](../raw/05-hooks-system.md)

## Architecture: 5-Layer Pipeline

Location: `packages/core/src/hooks/` (~2,800+ lines)

```
HookSystem (Coordinator)
├── HookRegistry     → Config loading & validation
├── HookPlanner      → Matcher-based hook selection
├── HookRunner       → Child process spawning
├── HookAggregator   → Event-specific result merging
└── HookEventHandler → Event firing methods
```

All logic in [[core-module]], shared by CLI and VSCode.

## 11 Hook Event Types

| # | Event | Category | Key Use Case |
|---|-------|----------|-------------|
| 1 | BeforeTool | Tool | Permission checks, security gates |
| 2 | AfterTool | Tool | Audit logging, result modification |
| 3 | BeforeAgent | Prompt/LLM | Prompt engineering, context injection |
| 4 | AfterAgent | Prompt/LLM | Response validation |
| 5 | BeforeModel | Prompt/LLM | Parameter optimization |
| 6 | AfterModel | Prompt/LLM | Response filtering, synthetic responses |
| 7 | BeforeToolSelection | Tool Selection | RBAC, tool whitelisting |
| 8 | SessionStart | Session | Environment setup |
| 9 | SessionEnd | Session | Resource cleanup |
| 10 | PreCompress | Other | Compression preparation |
| 11 | Notification | Other | Custom notification handling |

## Configuration

### Precedence (high → low)
1. Project: `.easycode/settings.json`
2. Global: `~/.easycode-user/settings.json`
3. System
4. Extensions

### Format
```json
{
  "hooks": {
    "BeforeTool": [{
      "matcher": "write_file|delete_file",
      "sequential": false,
      "hooks": [{
        "type": "command",
        "command": "bash .easycode/hooks/security-gate.sh",
        "timeout": 30000
      }]
    }]
  }
}
```

## I/O Protocol

- **Input**: JSON via stdin — `session_id`, `cwd`, `hook_event_name`, `timestamp` + event-specific fields
- **Output**: JSON via stdout — `decision`, `reason`, `continue`, `suppressOutput`, `systemMessage`, `hookSpecificOutput`
- **Exit codes**: 0=success, 1=warning (non-blocking), 2=blocking deny, others=failure (non-blocking)

## Aggregation Strategies

| Strategy | Events | Behavior |
|----------|--------|----------|
| OR-Decision | BeforeTool, AfterTool, BeforeAgent, AfterAgent, SessionStart | Any deny blocks; messages concat |
| Field Replacement | BeforeModel, AfterModel | Later hooks override earlier |
| Union | BeforeToolSelection | Union of allowed tools; NONE=most restrictive |

## Runner Process Model

- `spawn()` with `shell: true` for cross-platform
- JSON input via child stdin
- SIGTERM timeout (default 60s) with SIGKILL fallback after 5s
- `$GEMINI_PROJECT_DIR` and `$CLAUDE_PROJECT_DIR` env variable expansion

## HookTranslator

Provides stable, version-independent `LLMRequest`/`LLMResponse` format between GenAI SDK types and hook format. Singleton: `defaultHookTranslator` (class `HookTranslatorGenAIv1`).

## Active Integrations

- `turn.ts` (lines 238-378): Fires BeforeModel, BeforeToolSelection, AfterModel
- `coreToolScheduler.ts` (lines 209, 243): Passes hookEventHandler to [[ToolExecutionEngine]]
- `/hooks` slash command opens documentation URL

## Related Pages

- [[core-module]]
- [[tools-system]] (BeforeTool/AfterTool events)
- [[source-01-architecture]]
