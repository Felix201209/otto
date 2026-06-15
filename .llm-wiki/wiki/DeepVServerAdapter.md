---
type: entity
date: 2026-04-09
tags: [class, core, adapter, proxy-api]
sources: [raw/01-architecture.md, raw/02-core-module.md]
---

# EasyCodeServerAdapter

> Adapter implementing [[ContentGenerator]] for the EasyCode Lab proxy API.

## Overview

`EasyCodeServerAdapter` 将 EasyCode Lab 的代理 API 适配为 [[ContentGenerator]] 接口，使 [[GeminiClient]] 能够通过代理服务器与多种 AI 模型（Gemini、Claude 等）交互。

## Pattern

**Adapter Pattern**

## Default Server

`https://api-code.easycode-userlab.ai` (configured via `DEEPX_SERVER_URL` build define)

## Related

- [[ContentGenerator]] — interface it implements
- [[GeminiClient]] — consumer
- [[ProxyAuthManager]] — authentication for proxy
- [[core-module]]
