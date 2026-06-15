---
type: entity
date: 2026-04-09
tags: [class, core, hooks, coordinator]
sources: [raw/05-hooks-system.md, raw/02-core-module.md]
---

# HookSystem

> Coordinator wiring 5 layers of the hooks pipeline.

## Overview

`HookSystem` 是 [[hooks-system]] 的顶层协调器，将 [[HookRegistry]]、HookPlanner、HookRunner、HookAggregator、HookEventHandler 五层组件连接在一起。

## Pattern

**Coordinator Pattern**

## Location

`packages/core/src/hooks/hookSystem.ts` (~90 lines)

## Related

- [[HookRegistry]] — Layer 1: config loading
- [[hooks-system]] — parent concept
- [[core-module]]
