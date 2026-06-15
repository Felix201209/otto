---
type: entity
date: 2026-04-09
tags: [class, core, orchestrator, facade]
sources: [raw/02-core-module.md, raw/01-architecture.md]
---

# GeminiClient

> Central orchestrator class — the Facade of the [[core-module]].

## Overview

`GeminiClient` 是 Easy Code 的核心编排器，管理聊天会话、上下文压缩、循环检测和 token 限制。每个会话最多 100 轮对话。

## Key Responsibilities

- Chat session management
- History compression (via CompressionService)
- Loop detection (via LoopDetectionService)
- Token limit enforcement (max 100 turns)
- Delegates AI calls to [[ContentGenerator]] / [[EasyCodeServerAdapter]]

## Pattern

**Facade** — exposes a unified interface over complex subsystem interactions.

## Location

`packages/core/src/core/client.ts`

## Related

- [[ContentGenerator]] — abstract AI backend interface
- [[Turn]] — single conversation turn
- [[SceneManager]] — model routing
- [[core-module]]
