---
type: source-summary
date: 2026-04-09
tags: [core, module, classes, orchestration]
source: raw/02-core-module.md
---

# Source Summary: Core Module

> Summary of [raw/02-core-module.md](../raw/02-core-module.md)

## Entry Point

`packages/core/index.ts` → re-exports from `src/index.ts` plus named exports for models and events.

## Directory Layout (16 directories)

| Directory | Responsibility |
|-----------|---------------|
| `core/` | Central orchestration — [[GeminiClient]], [[ContentGenerator]], [[Turn]], [[SubAgent]], [[SceneManager]], [[ToolExecutionEngine]] |
| `tools/` | 30+ tool implementations — [[ToolRegistry]], [[BaseTool]], shell, edit, read-file, web-fetch, [[mcp-client]] |
| `config/` | Configuration — models, capabilities, server config, proxy, project settings |
| `services/` | Infrastructure — [[SessionManager]], GitService, FileDiscoveryService, CompressionService, LoopDetectionService, BackgroundTaskManager |
| `auth/` | Authentication — [[ProxyAuthManager]], AuthServer, easycodelabAuth |
| `hooks/` | Lifecycle — [[HookSystem]], [[HookRegistry]], HookRunner, HookAggregator, HookPlanner, HookEventHandler |
| `skills/` | Marketplace — [[SkillLoader]], [[MarketplaceManager]], PluginInstaller, ScriptExecutor, SkillContextInjector |
| `mcp/` | MCP OAuth — MCPOAuthProvider, token storage, utils |
| `utils/` | 40+ utilities — memory, paths, errors, retry, dangerousCommandDetector, editCorrector, summarizer |
| `events/` | Event system — tokenUsageEvents, realTimeTokenEvents |
| `telemetry/` | OpenTelemetry instrumentation |
| `prompts/` | Prompt construction |
| `types/` | TypeScript type definitions |
| `ide/` | IDE integration client |
| `lsp/` | Language Server Protocol client |
| `code_assist/` | Code assistance, inline completion |

## Key Classes

| Class | Pattern | Role |
|-------|---------|------|
| [[GeminiClient]] | Facade | Central orchestrator; chat, compression, loop detection, max 100 turns |
| [[ContentGenerator]] | Strategy/Adapter | Abstract AI backend interface |
| [[EasyCodeServerAdapter]] | Adapter | Implements ContentGenerator for proxy API |
| [[Turn]] | State Machine | Single conversation turn with `GeminiEventType` enum |
| [[ToolRegistry]] | Registry | Tool discovery, registration, MCP sync, name sanitization |
| [[BaseTool]] | Abstract Base | Concrete base implementing Tool interface |
| [[SubAgent]] | Agent | Independent multi-turn AI conversation engine |
| [[SceneManager]] | Strategy | Routes 9 scene types to optimal models |
| [[ToolExecutionEngine]] | Engine | Tool execution with confirmation flow |
| [[HookSystem]] | Observer/Lifecycle | Hook registry + runner + aggregator + planner |
| [[SessionManager]] | Repository | Session CRUD, cleanup, persistence, history |
| CompressionService | Service | Compresses chat history at token limits |
| LoopDetectionService | Service | Detects stuck tool-calling loops |
| [[SkillLoader]] / [[MarketplaceManager]] | Plugin Architecture | Marketplace with loading, installation, context injection |

## Related Pages

- [[source-01-architecture]]
- [[cli-module]]
- [[tools-system]]
- [[hooks-system]]
- [[mcp-system]]
