---
type: entity
date: 2026-04-09
tags: [class, core, mcp, client]
sources: [raw/07-mcp-system.md]
---

# mcp-client

> MCP client module managing server connections, tool discovery, and status tracking.

## Overview

`mcp-client.ts` (~900 lines) 是 [[mcp-system]] 的核心模块，负责：

- Sequential server startup with `setImmediate()` yield
- Transport selection (Stdio/SSE/Streamable HTTP)
- Connection lifecycle management
- Tool discovery and registration
- OAuth integration
- Real-time status updates

## Key Exports

| Symbol | Type | Purpose |
|--------|------|---------|
| `discoverMcpTools()` | Function | Main entry: sequential startup + discovery |
| `connectAndDiscover()` | Function | Single server lifecycle |
| `MCPServerStatus` | Enum | DISCONNECTED, CONNECTING, CONNECTED |
| `MCPDiscoveryState` | Enum | NOT_STARTED, IN_PROGRESS, COMPLETED |
| `addMCPStatusChangeListener()` | Function | Real-time UI updates |
| `syncMcpToolsToRegistry()` | Function | Cross-registry sync |

## Location

`packages/core/src/tools/mcp-client.ts`

## Related

- [[DiscoveredMCPTool]] — tool wrapper
- [[ToolRegistry]] — registration target
- [[mcp-system]] — parent system
