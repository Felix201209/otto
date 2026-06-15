---
type: entity
date: 2026-04-09
tags: [class, core, auth, proxy, singleton]
sources: [raw/01-architecture.md, raw/02-core-module.md]
---

# ProxyAuthManager

> Singleton managing JWT authentication via EasyCode Lab proxy servers.

## Overview

`ProxyAuthManager` 以单例模式管理通过 EasyCode Lab 服务器的 JWT 认证。是 Easy Code 的主要认证机制（proxy-first auth）。

## Pattern

**Singleton**

## Location

`packages/core/src/auth/`

## Related

- [[EasyCodeServerAdapter]] — uses ProxyAuthManager for API auth
- [[core-module]]
