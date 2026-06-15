---
type: entity
date: 2026-04-09
tags: [class, core, hooks, registry]
sources: [raw/05-hooks-system.md]
---

# HookRegistry

> Layer 1 of [[hooks-system]]: Configuration loading & validation.

## Overview

`HookRegistry` 从配置文件加载 hook 定义，验证其有效性，并追踪来源优先级。

## Configuration Sources (precedence)

1. Project: `.easycode/settings.json`
2. Global: `~/.easycode-user/settings.json`
3. System
4. Extensions

## Location

`packages/core/src/hooks/hookRegistry.ts` (~200 lines)

## Related

- [[HookSystem]] — coordinator
- [[hooks-system]] — parent concept
