---
type: overview
title: Easy Code - Project Overview
tags: [overview, project, ai, cli, vscode, typescript]
date: 2026-04-09
sources: [README.md, package.json]
---

# Easy Code - Project Overview

## What is Easy Code?

Easy Code 是一款 AI 驱动的智能编程助手，通过深度整合人工智能技术提升软件开发效率。与传统代码补全工具不同，它是一个能够理解整个项目上下文、自主编排工具完成复杂任务的智能代理（Agent）。

## Key Facts

- **Package name:** `easycode-ai`
- **Version:** 1.0.316
- **License:** Apache-2.0
- **Runtime:** Node.js >= 20.0.0
- **Language:** TypeScript 5.0+
- **Repository:** github.com/OrionStarAI/EasyCodeCode
- **Author:** Easy Code Team

## Monorepo Structure

This is a monorepo managed via npm workspaces with three packages:

| Package | Path | Purpose |
|---------|------|---------|
| `cli` | `packages/cli` | Command-line interface entry point |
| `core` | `packages/core` | Core logic, tools, AI interaction |
| `vscode-ui-plugin` | `packages/vscode-ui-plugin` | VS Code extension UI |

An additional companion extension lives at `packages/vscode-ide-companion`.

## Core Capabilities

- **AI-driven code generation & refactoring** — natural language to code, bug fixing, multi-language support
- **Intelligent debugging** — error log analysis, stack trace diagnosis, auto-fix
- **[[mcp-system|MCP (Model Context Protocol)]]** — full-project context, cross-file analysis, third-party MCP servers
- **[[tools-system|Extensible tool system]]** — file ops, shell, web fetch/search, grep, memory, task agents
- **[[hooks-system|Hooks]]** — PreToolExecution, PostToolExecution, OnSessionStart, OnSessionEnd
- **Session management** — persistence, resume, history compression, checkpoint rollback
- **[[skills-system|Skills system]]** — pluggable skill modules for specialized workflows

## Build & Dev

- `npm run dev` — start in development mode
- `npm run build` — build all packages
- `npm run bundle` — build + esbuild bundle + copy assets
- `npm run pack:prod` — full production packaging (cross-platform)

## Key Directories

- `packages/` — monorepo packages (cli, core, vscode extensions)
- `scripts/` — build, packaging, and utility scripts
- `docs/` — extensive documentation on features, architecture, tools
- `bundle/` — output for bundled artifacts
- `.easycode/` — project-level configuration and wiki

## Related Pages

- [[core-module]] — 后端引擎：API、工具、会话、认证
- [[cli-module]] — 终端前端：Ink/React UI、斜杠命令
- [[tools-system]] — 可扩展工具框架（27个内置工具）
- [[hooks-system]] — 5层生命周期钩子管道
- [[mcp-system]] — MCP 协议集成
- [[build-system]] — 两管道构建系统
- [[skills-system]] — 可插拔技能模块/市场
