---
type: entity
date: 2026-04-09
tags: [core, module, backend, packages]
sources: [raw/01-architecture.md, raw/02-core-module.md]
---

# Core Module

> `packages/core` — The backend engine of Easy Code.

## Overview

Core 是 Easy Code 的后端包（NPM 名 `easycode-core`），包含所有 AI 交互、工具编排、会话管理和认证逻辑。它是 UI 无关的，可以同时被 [[cli-module]] 和 VSCode 插件使用。

## Package Info

- **Path**: `packages/core`
- **NPM**: `easycode-core`
- **Entry**: `index.ts` → re-exports from `src/index.ts`

## Key Subdirectories

| Directory | Key Contents |
|-----------|-------------|
| `core/` | [[GeminiClient]], [[ContentGenerator]], [[Turn]], [[SubAgent]], [[SceneManager]], [[ToolExecutionEngine]] |
| `tools/` | [[ToolRegistry]], [[BaseTool]], 30+ tool implementations, [[mcp-client]] |
| `config/` | Models, capabilities, server config, proxy, project settings |
| `services/` | [[SessionManager]], GitService, CompressionService, LoopDetectionService |
| `auth/` | [[ProxyAuthManager]], AuthServer |
| `hooks/` | [[HookSystem]], [[HookRegistry]] |
| `skills/` | [[SkillLoader]], [[MarketplaceManager]] |
| `mcp/` | OAuth provider, token storage |
| `utils/` | 40+ shared utilities |

## Dependencies

- Depended on by: `packages/cli`, `packages/vscode-ui-plugin`
- Major externals: `@google/genai`, `@modelcontextprotocol/sdk`, `@opentelemetry/*`, `simple-git`, `@vscode/ripgrep`

## Sources

- [[source-01-architecture]]
- [[source-02-core-module]]
