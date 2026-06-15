---
type: entity
date: 2026-04-09
tags: [cli, module, frontend, terminal, ink, react]
sources: [raw/01-architecture.md, raw/03-cli-module.md]
---

# CLI Module

> `packages/cli` — The terminal frontend of Easy Code.

## Overview

CLI 是 Easy Code 的终端前端包（NPM 名 `easycode-cli`），使用 Ink/React 构建交互式终端 UI，提供流式 AI 响应、50+ 斜杠命令、主题系统和工具确认界面。

## Package Info

- **Path**: `packages/cli`
- **NPM**: `easycode-cli`
- **Entry**: `index.ts` → shebang → `main()` from `src/gemini.tsx`
- **Binary**: `easycode`

## Two Modes

1. **Interactive**: Full Ink/React UI — streaming, slash commands, themes, tool confirmations
2. **Non-interactive**: Piped input or `-p` flag — headless, structured output

## Key Components

- **AppWrapper / App**: Root Ink/React component tree
- **useGeminiStream**: Hook managing streaming AI responses
- **useSlashCommandProcessor**: Hook handling 50+ slash commands
- **themeManager**: Singleton for theme loading/switching
- **Extension system**: Dynamic loading via `loadExtensions()` with TOML prompt extensions

## Key Directories

| Directory | Contents |
|-----------|---------|
| `ui/components/` | 60+ UI components |
| `ui/commands/` | 50+ slash commands |
| `ui/hooks/` | React hooks |
| `ui/themes/` | Theme definitions |

## Dependencies

- Depends on: [[core-module]]
- Major externals: `ink` (custom fork), `react` v19.2.0, `yargs`, `highlight.js`, `js-tiktoken`, `zod`

## Sources

- [[source-01-architecture]]
- [[source-03-cli-module]]
