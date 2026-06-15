---
type: entity
date: 2026-04-09
tags: [class, core, scene-manager, strategy, model-routing]
sources: [raw/01-architecture.md, raw/02-core-module.md]
---

# SceneManager

> Routes task types to optimal AI models (Strategy pattern, 9 scene types).

## Overview

`SceneManager` 与 `SceneType` 枚举配合，将不同类型的任务路由到最优的 AI 模型。支持 9 种场景类型，包括 CHAT、WEB_FETCH、CODE_ASSIST 等。

## Scene Types

CHAT, WEB_FETCH, CODE_ASSIST, and 6 others (exact list from codebase).

## Pattern

**Strategy Pattern** — selects model per scene type.

## Location

`packages/core/src/core/sceneManager.ts`

## Related

- [[GeminiClient]] — uses SceneManager for model selection
- [[ContentGenerator]] — the abstraction SceneManager selects implementations for
- [[core-module]]
