# LLM Wiki Index

> Auto-maintained by Easy Code. Do not edit manually.

## Sources

| # | File | Summary Page | Description | Generated |
|---|------|-------------|-------------|-----------|
| 01 | [raw/01-architecture.md](raw/01-architecture.md) | [source-01-architecture](wiki/source-01-architecture.md) | Project architecture, monorepo structure, dependencies, design patterns | 2026-04-09 |
| 02 | [raw/02-core-module.md](raw/02-core-module.md) | [source-02-core-module](wiki/source-02-core-module.md) | Core module directory layout, key classes, exports | 2026-04-09 |
| 03 | [raw/03-cli-module.md](raw/03-cli-module.md) | [source-03-cli-module](wiki/source-03-cli-module.md) | CLI module structure, entry point, components, two modes | 2026-04-09 |
| 04 | [raw/04-tools-system.md](raw/04-tools-system.md) | [source-04-tools-system](wiki/source-04-tools-system.md) | Complete tool list (27 built-in), tool patterns, execution state machine | 2026-04-09 |
| 05 | [raw/05-hooks-system.md](raw/05-hooks-system.md) | [source-05-hooks-system](wiki/source-05-hooks-system.md) | Hooks 5-layer architecture, 11 event types, configuration, I/O protocol | 2026-04-09 |
| 06 | [raw/06-build-and-scripts.md](raw/06-build-and-scripts.md) | [source-06-build-system](wiki/source-06-build-system.md) | Build pipelines, esbuild config, CI/CD, npm publishing, TypeScript/ESLint config | 2026-04-09 |
| 07 | [raw/07-mcp-system.md](raw/07-mcp-system.md) | [source-07-mcp-system](wiki/source-07-mcp-system.md) | MCP architecture, transport types, OAuth, two-phase loading, status display | 2026-04-09 |

## Entities

### Modules / Systems

| Page | Type | Description |
|------|------|-------------|
| [workflow-system](wiki/workflow-system.md) | entity | Dynamic Workflow — JS orchestration, multi-agent, token budget backlog |
| [core-module](wiki/core-module.md) | entity | Backend engine — API, tools, sessions, auth |
| [cli-module](wiki/cli-module.md) | entity | Terminal frontend — Ink/React UI, slash commands |
| [tools-system](wiki/tools-system.md) | entity | Extensible tool framework — 31 built-in tools |
| [hooks-system](wiki/hooks-system.md) | entity | 5-layer lifecycle hook pipeline — 11 event types |
| [mcp-system](wiki/mcp-system.md) | entity | MCP protocol integration — external tool discovery |
| [build-system](wiki/build-system.md) | entity | Two-pipeline build: tsc + esbuild |
| [skills-system](wiki/skills-system.md) | entity | Pluggable skill modules / marketplace |
| [background-tasks](wiki/background-tasks.md) | entity | Background Task system - process control & execution |
| [feishu-integration](wiki/feishu-integration.md) | entity | Feishu / Lark Bot Integration - WebSocket long-polling gateway |

### Classes / Components

| Page | Type | Pattern | Location |
|------|------|---------|----------|
| [GeminiClient](wiki/GeminiClient.md) | entity | Facade | `core/src/core/client.ts` |
| [ContentGenerator](wiki/ContentGenerator.md) | entity | Strategy/Adapter | `core/src/core/contentGenerator.ts` |
| [EasyCodeServerAdapter](wiki/EasyCodeServerAdapter.md) | entity | Adapter | `core/src/core/` |
| [SceneManager](wiki/SceneManager.md) | entity | Strategy | `core/src/core/sceneManager.ts` |
| [Turn](wiki/Turn.md) | entity | State Machine | `core/src/core/turn.ts` |
| [SubAgent](wiki/SubAgent.md) | entity | Agent | `core/src/core/subAgent.ts` |
| [ToolRegistry](wiki/ToolRegistry.md) | entity | Registry | `core/src/tools/tool-registry.ts` |
| [BaseTool](wiki/BaseTool.md) | entity | Abstract Base | `core/src/tools/tools.ts` |
| [ToolExecutionEngine](wiki/ToolExecutionEngine.md) | entity | State Machine | `core/src/core/toolExecutionEngine.ts` |
| [DiscoveredMCPTool](wiki/DiscoveredMCPTool.md) | entity | Adapter | `core/src/tools/mcp-tool.ts` |
| [mcp-client](wiki/mcp-client.md) | entity | Module | `core/src/tools/mcp-client.ts` |
| [HookSystem](wiki/HookSystem.md) | entity | Coordinator | `core/src/hooks/hookSystem.ts` |
| [HookRegistry](wiki/HookRegistry.md) | entity | Registry | `core/src/hooks/hookRegistry.ts` |
| [ProxyAuthManager](wiki/ProxyAuthManager.md) | entity | Singleton | `core/src/auth/` |
| [SessionManager](wiki/SessionManager.md) | entity | Repository | `core/src/services/sessionManager.ts` |
| [SkillLoader](wiki/SkillLoader.md) | entity | Plugin | `core/src/skills/skill-loader.ts` |
| [MarketplaceManager](wiki/MarketplaceManager.md) | entity | Plugin | `core/src/skills/marketplace-manager.ts` |
| [lark-cli-tool](wiki/lark-cli-tool.md) | entity | Tool | `core/src/tools/lark-cli.ts` |
| [audio-reader](packages/core/src/tools/audio-reader.ts) | entity | Tool | `core/src/tools/audio-reader.ts` |

## Overview

| Page | Description |
|------|-------------|
| [overview](wiki/overview.md) | Project-level overview from README.md and package.json |

## Features & Enhancements

| Page | Description |
|------|-------------|
| [debate-i18n-enhancement](wiki/debate-i18n-enhancement.md) | Debate mode i18n & language selection — multilingual UI and prompts |
| [goal-driven-mode](wiki/goal-driven-mode.md) | Goal-Driven state machine, watchdog control, contract boundaries, and goal_achieved triggers |
| [context-compression](wiki/context-compression.md) | Token-aware MicroCompactService, post-compact restoration, and prefill crash guards |
| [adaptive-thinking](wiki/adaptive-thinking.md) | Adaptive thinking effort mappings (Claude/OpenAI/Gemini), UI brain outlines, and sanitization |

## Guides & Checklists

| Page | Description |
|------|-------------|
| [adding-builtin-tool-checklist](wiki/adding-builtin-tool-checklist.md) | Checklist & pitfalls when adding a built-in tool to `core/src/tools/` (derived from `local_time` debugging) |
| [release-process](wiki/release-process.md) | Standardized release process guide for easycode-ai client, including strict tag and commit rules |

## Synthesis
<!-- Cross-cutting analysis pages will be listed here -->
