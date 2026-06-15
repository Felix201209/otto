---
type: source-summary
date: 2026-04-09
tags: [architecture, monorepo, design-patterns, dependencies]
source: raw/01-architecture.md
---

# Source Summary: Architecture

> Summary of [raw/01-architecture.md](../raw/01-architecture.md)

## Key Facts

- **Project**: easycode-ai v1.0.316, Apache-2.0, TypeScript 5.0+ / ESM
- **Origin**: Forked from Google Gemini CLI (`google-gemini/gemini-cli`)
- **Runtime**: Node.js >= 20.0.0
- **Repository**: github.com/OrionStarAI/EasyCodeCode

## Monorepo Structure

4 packages via npm workspaces:

| Package | NPM Name | Role |
|---------|-----------|------|
| `packages/core` | `easycode-core` | Backend — API, tools, sessions, auth |
| `packages/cli` | `easycode-cli` | Frontend — terminal UI (Ink/React) |
| `packages/vscode-ide-companion` | — | VS Code IDE companion |
| `packages/vscode-ui-plugin` | — | VS Code UI plugin |

Dependency chain: `cli → core`, `vscode-ui-plugin → core`, `vscode-ide-companion` is standalone.

## Interaction Flow

User Input → [[cli-module]] → [[core-module]] → [[GeminiClient]] → AI Backend → Tool Execution → Response Display

## Design Principles

- **Frontend/backend separation**: [[core-module]] is UI-independent
- **Scene-based model routing**: [[SceneManager]] routes tasks to optimal models (9 scene types)
- **Proxy-first auth**: [[ProxyAuthManager]] with JWT via EasyCode Lab servers
- **Extensibility**: Extensions, [[hooks-system]], [[skills-system]], [[mcp-system]], custom models
- **Resilient**: Loop detection, history compression, model fallback, error recovery

## Design Patterns

| Pattern | Implementation |
|---------|---------------|
| Registry | [[ToolRegistry]], [[HookRegistry]], ResourceRegistry |
| Adapter | [[EasyCodeServerAdapter]] → [[ContentGenerator]] |
| Strategy | [[SceneManager]], [[ContentGenerator]] |
| Observer | Event managers (token usage, real-time tokens) |
| Singleton | [[ProxyAuthManager]], themeManager, settingsManager |
| Command | Slash commands |
| Coordinator | [[HookSystem]] |
| Factory | `createHookOutput()`, `createTransport()` |

## Core Dependencies

| Dependency | Purpose |
|------------|---------|
| `@google/genai` v1.35.0 | Gemini API SDK |
| `@modelcontextprotocol/sdk` v1.25.2 | [[mcp-system]] protocol |
| `@opentelemetry/*` | Observability |
| `simple-git` | Git operations |
| `@vscode/ripgrep` | File searching |
| `ink` (custom fork) | Terminal React renderer |
| `react` v19.2.0 | UI components |
| `yargs` v17.7.2 | CLI argument parsing |

## Related Pages

- [[core-module]]
- [[cli-module]]
- [[tools-system]]
- [[hooks-system]]
- [[mcp-system]]
- [[build-system]]
