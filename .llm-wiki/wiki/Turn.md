---
type: entity
date: 2026-04-09
tags: [class, core, turn, state-machine, conversation]
sources: [raw/02-core-module.md]
---

# Turn

> Represents a single conversation turn with event-driven state.

## Overview

`Turn` 管理单次对话轮次的完整生命周期，通过 `GeminiEventType` 枚举驱动事件。在 `turn.ts` 中触发 [[hooks-system]] 事件（BeforeModel、BeforeToolSelection、AfterModel）。

## Pattern

**State Machine** with event-driven transitions.

## Location

`packages/core/src/core/turn.ts`

## Hook Integration

Lines 238-378: Fires BeforeModel, BeforeToolSelection, AfterModel events.

## Related

- [[GeminiClient]] — manages turns
- [[hooks-system]] — hooks fired during turn lifecycle
- [[core-module]]
