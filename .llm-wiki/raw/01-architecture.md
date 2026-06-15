# Easy Code — Architecture Facts

> Auto-generated from codebase analysis on 2026-04-09. Immutable source document.

## Project Identity

- **Name**: easycode-ai
- **Version**: 1.0.316
- **License**: Apache-2.0
- **Runtime**: Node.js >= 20.0.0
- **Language**: TypeScript 5.0+, ESM modules
- **Repository**: github.com/OrionStarAI/EasyCodeCode
- **Author**: Easy Code Team
- **Origin**: Forked from Google Gemini CLI (google-gemini/gemini-cli)

## Monorepo Structure

npm workspaces, 4 packages:

| Package | NPM Name | Role |
|---------|-----------|------|
| `packages/core` | `easycode-core` | Backend — API communication, tool orchestration, session management, auth |
| `packages/cli` | `easycode-cli` | Frontend — terminal UI (Ink/React), slash commands, themes |
| `packages/vscode-ide-companion` | — | VS Code IDE companion extension |
| `packages/vscode-ui-plugin` | — | VS Code UI plugin |

## High-Level Interaction Flow

1. User Input → CLI captures via Ink/React terminal
2. CLI → Core → passes prompt to `GeminiClient`
3. Core → API → constructs prompt, sends to AI backend (Gemini, Claude, or custom models via `EasyCodeServerAdapter`)
4. API → Core → receives response; if tool call requested, executes tool
5. Tool Execution → Core runs tool (with user confirmation for destructive ops)
6. Core → CLI → returns final response
7. CLI → Display → renders formatted output

## Key Design Principles

- **Frontend/backend separation**: Core is UI-independent, can support multiple frontends
- **Scene-based model routing**: `SceneManager` routes task types to optimal AI models (9 scene types)
- **Proxy-first auth**: Uses `ProxyAuthManager` with JWT via EasyCode Lab servers
- **Extensibility**: Extensions, hooks, skills marketplace, MCP protocol, custom models
- **Resilient**: Loop detection, history compression, model fallback, error recovery, graceful shutdown

## Inter-Package Dependencies

```
packages/cli  →  packages/core  (file: dependency)
packages/vscode-ui-plugin  →  packages/core  (file: dependency)
packages/vscode-ide-companion  (standalone, esbuild-bundled)
```

## Design Patterns Observed

- **Registry Pattern**: `ToolRegistry` for tools, `HookRegistry` for hooks, `ResourceRegistry` for MCP resources
- **Adapter Pattern**: `EasyCodeServerAdapter` adapts proxy API to `ContentGenerator` interface
- **Strategy Pattern**: `SceneManager` selects model per scene type; `ContentGenerator` abstraction
- **Observer Pattern**: Event managers for token usage, real-time tokens, app events
- **Singleton Pattern**: `ProxyAuthManager`, `themeManager`, `terminalSizeManager`, `settingsManager`, `marketplaceManager`
- **Command Pattern**: Each slash command implements a handler function
- **Coordinator Pattern**: `HookSystem` orchestrates sub-components
- **Factory Pattern**: `createHookOutput()`, `createTransport()` produce typed instances

## External Dependencies (Core)

| Dependency | Purpose |
|------------|---------|
| `@google/genai` (v1.35.0) | Gemini API SDK |
| `@modelcontextprotocol/sdk` (v1.25.2) | MCP protocol |
| `@opentelemetry/*` | Full observability (traces, metrics, logs) |
| `simple-git` | Git operations for checkpointing |
| `@vscode/ripgrep` | Fast file searching |
| `undici` | HTTP client with proxy support |
| `ws` | WebSocket support |
| `pdf-parse`, `mammoth`, `xlsx` | Document parsing (PDF, Word, Excel) |
| `jimp`, `jszip` | Image processing and zip |
| `vscode-jsonrpc`, `vscode-languageserver-types` | LSP support |

## External Dependencies (CLI)

| Dependency | Purpose |
|------------|---------|
| `ink` (custom fork `@jrichman/ink@6.4.7`) | Terminal React renderer |
| `react` (v19.2.0) | UI components |
| `yargs` (v17.7.2) | CLI argument parsing |
| `highlight.js` + `lowlight` | Syntax highlighting |
| `js-tiktoken` | Token counting |
| `express` (v5.1.0) | Local server (auth callbacks) |
| `zod` | Schema validation |
| `@iarna/toml` | TOML config parsing |
