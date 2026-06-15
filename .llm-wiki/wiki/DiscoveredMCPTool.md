---
type: entity
date: 2026-04-09
tags: [class, core, mcp, tool, discovered-tool]
sources: [raw/07-mcp-system.md, raw/04-tools-system.md]
---

# DiscoveredMCPTool

> Wrapper extending [[BaseTool]] to expose MCP server tools as native tools.

## Overview

`DiscoveredMCPTool` 将 MCP 服务器上发现的工具包装为原生的 [[BaseTool]] 实例，使其能够在 [[ToolRegistry]] 中注册并像内置工具一样使用。

## Key Features

- **Confirmation**: Trust bypass → allowlist → user confirmation ("always allow" option)
- **Execution**: `Promise.race()` of MCP call, abort signal, timeout
- **Name generation**: `generateValidName()` for Gemini + Claude API compatibility
- **Cloning**: `clone()` for cross-[[ToolRegistry]] sharing (VSCode multi-instance)
- **Schema**: Returns `parametersJsonSchema` as function declaration

## Location

`packages/core/src/tools/mcp-tool.ts` (~350 lines)

## Related

- [[BaseTool]] — base class
- [[ToolRegistry]] — registration target
- [[mcp-system]] — parent system
- [[tools-system]]
