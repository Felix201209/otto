---
type: entity
date: 2026-04-09
tags: [class, core, session, repository]
sources: [raw/02-core-module.md]
---

# SessionManager

> Session CRUD, cleanup, persistence, and history management.

## Overview

`SessionManager` 以 Repository 模式管理会话的创建、读取、更新、删除、清理和持久化。支持会话历史和恢复。

## Pattern

**Repository Pattern**

## Location

`packages/core/src/services/sessionManager.ts`

## Related

- [[GeminiClient]] — uses SessionManager for session lifecycle
- [[core-module]]
