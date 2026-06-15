# Easy Code — Core Module Facts

> Auto-generated from codebase analysis on 2026-04-09. Immutable source document.

## Entry Point

`packages/core/index.ts` re-exports everything from `src/index.ts` plus specific named exports for models and events.

## Directory Layout

| Directory | Responsibility |
|-----------|---------------|
| `core/` | Central orchestration — `client.ts`, `contentGenerator.ts`, `geminiChat.ts`, `turn.ts`, `subAgent.ts`, `sceneManager.ts`, `toolExecutionEngine.ts` |
| `tools/` | 30+ tool implementations — `tools.ts` (base), `tool-registry.ts`, `shell.ts`, `edit.ts`, `read-file.ts`, `web-fetch.ts`, `mcp-client.ts` |
| `config/` | Configuration — `config.ts`, `models.ts`, `modelCapabilities.ts`, `serverConfig.ts`, `proxyConfig.ts`, `projectSettings.ts` |
| `services/` | Infrastructure — `sessionManager.ts`, `gitService.ts`, `fileDiscoveryService.ts`, `compressionService.ts`, `loopDetectionService.ts`, `backgroundTaskManager.ts` |
| `auth/` | Authentication — `authenticatedHttpClient.ts`, `authNavigator.ts`, `login/authServer.ts`, `login/easycodelabAuth.ts` |
| `hooks/` | Lifecycle hooks — `hookSystem.ts`, `hookRegistry.ts`, `hookRunner.ts`, `hookAggregator.ts`, `hookPlanner.ts`, `hookEventHandler.ts` |
| `skills/` | Skills marketplace — `skill-loader.ts`, `marketplace-manager.ts`, `plugin-installer.ts`, `script-executor.ts`, `skill-context-injector.ts` |
| `mcp/` | MCP integration — `oauth-provider.ts`, `oauth-token-storage.ts`, `oauth-utils.ts`, `login-provider.ts` |
| `utils/` | 40+ shared utilities — `memoryDiscovery.ts`, `paths.ts`, `errors.ts`, `retry.ts`, `dangerousCommandDetector.ts`, `editCorrector.ts`, `summarizer.ts` |
| `events/` | Event system — `tokenUsageEvents.ts`, `realTimeTokenEvents.ts` |
| `telemetry/` | OpenTelemetry instrumentation |
| `prompts/` | Prompt construction — `mcp-prompts.ts` |
| `types/` | TypeScript types — `extendedContent.ts`, `customModel.ts` |
| `ide/` | IDE integration — `ide-client.ts`, `ideContext.ts` |
| `lsp/` | Language Server Protocol client |
| `code_assist/` | Code assistance — `codeAssist.ts`, `server.ts`, `inlineCompletion.ts` |
| `resources/` | Resource management — `resource-registry.ts` |

## Key Classes

| Class | Pattern | Responsibility |
|-------|---------|---------------|
| `GeminiClient` | Facade | Central orchestrator; manages chat, compression, loop detection, token limits. Max 100 turns per session |
| `ContentGenerator` | Strategy/Adapter | Abstract interface for AI backends. Implemented by `EasyCodeServerAdapter` |
| `Turn` | State Machine | Single conversation turn with events via `GeminiEventType` enum |
| `ToolRegistry` | Registry | Tool discovery, registration, MCP sync; tool name sanitization |
| `Tool<TParams, TResult>` | Interface | Base tool interface — `validateToolParams()`, `execute()`, `shouldConfirmExecute()`, `getAffectedFiles()` |
| `BaseTool` | Abstract Base | Concrete base implementing `Tool` interface |
| `SubAgent` | Agent | Independent AI conversation engine for complex multi-turn tasks |
| `SceneManager` + `SceneType` | Strategy | Routes task types to models (9 types: CHAT, WEB_FETCH, CODE_ASSIST, etc.) |
| `ToolExecutionEngine` | Engine | Tool execution with confirmation flow |
| `HookSystem` | Observer/Lifecycle | Hook registry + runner + aggregator + planner |
| `SessionManager` | Repository | Session CRUD, cleanup, persistence, history |
| `CompressionService` | Service | Compresses chat history at token limits |
| `LoopDetectionService` | Service | Detects stuck tool-calling loops |
| `SkillLoader` / `MarketplaceManager` / `PluginInstaller` | Plugin Architecture | Full marketplace with loading, installation, context injection |

## Key Exports

- **Config**: `Config`, `DEFAULT_GEMINI_MODEL`, `DEFAULT_GEMINI_FLASH_MODEL`, model capabilities
- **Client**: `GeminiClient`, `ContentGenerator`, `GeminiChat`
- **Tools**: All 30+ tool implementations, `ToolRegistry`, tool base classes
- **Auth**: `AuthServer`, `ProxyAuthManager`, `AuthType`
- **Services**: `SessionManager`, `FileDiscoveryService`, `GitService`, `BackgroundTaskManager`
- **Events**: `tokenUsageEventManager`, `realTimeTokenEventManager`
- **Skills**: `SkillLoader`, `MarketplaceManager`, `PluginInstaller`, `initializeSkillsContext`
- **Hooks**: `HookSystem`, `HookRegistry`, `HookRunner`
- **MCP**: `MCPOAuthProvider`, `MCPOAuthToken`, `OAuthUtils`
