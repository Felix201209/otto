---
type: entity
date: 2026-04-09
tags: [class, core, tool-registry, registry-pattern]
sources: [raw/04-tools-system.md, raw/02-core-module.md]
---

# ToolRegistry

> Central registry for all tools — built-in, discovered, and MCP.

## Overview

`ToolRegistry` 管理所有工具的注册、发现和检索。支持内置工具注册、MCP 工具同步、工具名称清洗和验证。

## Key Responsibilities

- Tool registration via `registerCoreTool()`
- MCP tool sync via `syncMcpToolsToRegistry()`
- Tool name validation: `^[a-zA-Z0-9_-]{1,128}$`
- Non-ASCII names → MD5 hashing
- `bash` → `run_shell_command` alias
- Command-line tool discovery
- Whitelist (`coreTools`) and blacklist (`excludeTools`) filtering

## Pattern

**Registry Pattern**

## Location

`packages/core/src/tools/tool-registry.ts`

## Related

- [[BaseTool]] — base class for registered tools
- [[DiscoveredMCPTool]] — MCP tool wrapper
- [[ToolExecutionEngine]] — retrieves tools from registry
- [[tools-system]]
