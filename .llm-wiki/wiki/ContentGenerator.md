---
type: entity
date: 2026-04-09
tags: [class, core, content-generator, strategy, adapter]
sources: [raw/02-core-module.md, raw/01-architecture.md]
---

# ContentGenerator

> Abstract interface for AI backends (Strategy pattern).

## Overview

`ContentGenerator` 是 AI 后端的抽象接口，定义了与 AI 模型交互的标准协议。由 [[EasyCodeServerAdapter]] 实现，适配代理 API 到统一的内容生成接口。

## Pattern

**Strategy / Adapter** — allows switching AI backends without changing client code.

## Implementation

- [[EasyCodeServerAdapter]] — adapts EasyCode Lab proxy API

## Location

`packages/core/src/core/contentGenerator.ts`

## Related

- [[GeminiClient]] — uses ContentGenerator for AI calls
- [[SceneManager]] — selects model variant per scene type
- [[core-module]]
