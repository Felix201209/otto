---
type: entity
date: 2026-04-09
tags: [mcp, protocol, tool-discovery, oauth, transport]
sources: [raw/07-mcp-system.md]
---

# MCP System

> Model Context Protocol integration for external tool discovery and execution.

## Overview

MCP（Model Context Protocol）系统允许 Easy Code 连接外部 MCP 服务器，动态发现和使用第三方工具。支持 Stdio、SSE 和 Streamable HTTP 三种传输方式，以及完整的 OAuth 认证流程。

## Two-Phase Loading

1. **Phase 1 (Sync)**: 加载内置工具 → CLI 立即可用
2. **Phase 2 (Async)**: 顺序连接 MCP 服务器 → 工具逐步出现

## Transport Types

| Type | Config Key | Method |
|------|-----------|--------|
| Stdio | `command` | Subprocess stdin/stdout |
| SSE | `url` | Server-Sent Events |
| Streamable HTTP | `httpUrl` | HTTP streaming |

## Key Components

| Component | Role |
|-----------|------|
| `mcp-client.ts` | Connection management, discovery, status tracking |
| [[DiscoveredMCPTool]] | Wraps MCP tools as native [[BaseTool]] instances |
| OAuth provider | Auto-discovery, token storage (`~/.gemini/mcp-oauth-tokens.json`) |

## Tool Discovery Flow

Server declarations → Filter (includeTools/excludeTools) → Name sanitization → Conflict resolution (first wins unprefixed) → Wrap in [[DiscoveredMCPTool]] → Register in [[ToolRegistry]]

## Configuration

Via `mcpServers` in `settings.json`. Supports `command`, `args`, `url`, `httpUrl`, `headers`, `env`, `timeout`, `trust`, `includeTools`, `excludeTools`, `oauth`.

## Sources

- [[source-07-mcp-system]]
