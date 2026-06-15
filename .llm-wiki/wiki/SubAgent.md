---
type: entity
date: 2026-04-09
tags: [class, core, sub-agent, task-tool]
sources: [raw/02-core-module.md, raw/04-tools-system.md]
---

# SubAgent

> Independent AI conversation engine for complex multi-turn tasks.

## Overview

`SubAgent` 是一个独立的 AI 对话引擎，由 `TaskTool` (task) 工具生成，用于处理复杂的多轮任务。仅在 CLI 模式下可用（非 VSCode）。

## Usage

通过 `task` 工具（`TaskTool`）触发，创建独立的对话上下文来完成子任务。

## Pattern

**Agent Pattern** — independent multi-turn conversation.

## Location

`packages/core/src/core/subAgent.ts`

## Related

- [[GeminiClient]] — main conversation engine
- [[tools-system]] — TaskTool spawns SubAgent
- [[core-module]]
