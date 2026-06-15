---
type: entity
date: 2026-04-09
tags: [hooks, lifecycle, events, security, extensibility]
sources: [raw/05-hooks-system.md]
---

# Hooks System

> 5-layer lifecycle hook pipeline for intercepting and modifying Easy Code behavior.

## Overview

Hooks 系统提供 11 种事件类型的生命周期拦截能力，用于安全控制、审计日志、提示工程和响应过滤。采用 5 层管道架构，全部在 [[core-module]] 中实现。

## 5-Layer Architecture

| Layer | Component | Role |
|-------|-----------|------|
| 1 | [[HookRegistry]] | Configuration loading & validation |
| 2 | HookPlanner | Matcher-based hook selection |
| 3 | HookRunner | Child process spawning & execution |
| 4 | HookAggregator | Event-specific result merging |
| 5 | HookEventHandler | Event firing methods |

Coordinator: [[HookSystem]] wires all layers together.

## 11 Event Types

**Tool**: BeforeTool, AfterTool
**Prompt/LLM**: BeforeAgent, AfterAgent, BeforeModel, AfterModel
**Tool Selection**: BeforeToolSelection
**Session**: SessionStart, SessionEnd
**Other**: PreCompress, Notification

## I/O Protocol

- Input: JSON via stdin
- Output: JSON via stdout
- Exit codes: 0=success, 1=warning, 2=blocking deny

## Configuration Precedence

Project `.easycode/settings.json` > Global `~/.easycode-user/settings.json` > System > Extensions

## Sources

- [[source-05-hooks-system]]
