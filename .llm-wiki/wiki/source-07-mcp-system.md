---
type: source-summary
date: 2026-04-09
tags: [mcp, protocol, oauth, transport, tool-discovery]
source: raw/07-mcp-system.md
---

# Source Summary: MCP System

> Summary of [raw/07-mcp-system.md](../raw/07-mcp-system.md)

## Architecture

Location: `packages/core/src/tools/` (mcp-client.ts ~900 lines, mcp-tool.ts ~350 lines) + `packages/core/src/mcp/` (OAuth)

```
MCP System
├── mcp-client.ts        → Connection management, discovery, OAuth, status
├── mcp-tool.ts          → DiscoveredMCPTool wrapping MCP tools as native tools
├── mcp/oauth-provider.ts    → OAuth authentication
├── mcp/oauth-utils.ts       → OAuth utilities
├── mcp/oauth-token-storage.ts → Token persistence
├── mcp/login-provider.ts    → Login flow
└── tool-registry.ts         → Central registration (shared with built-in tools)
```

## Two-Phase Loading

1. **Phase 1 (Sync)**: Load core built-in tools → CLI immediately usable
2. **Phase 2 (Async)**: Connect to MCP servers sequentially → tools appear incrementally

Sequential startup with `setImmediate()` yield between servers (~100-200ms per server).

## Transport Types

| Transport | Config Trigger | Communication |
|-----------|---------------|--------------|
| Stdio | `command` field | Subprocess stdin/stdout |
| SSE | `url` field | Server-Sent Events HTTP |
| Streamable HTTP | `httpUrl` field | HTTP streaming |

## Connection Lifecycle

CONNECTING → Transport selection → Client creation → Connect (30s timeout, 10min request timeout) → Discovery → Registration → CONNECTED or DISCONNECTED

## Tool Discovery Pipeline

1. Fetch declarations from server
2. Filter via `includeTools`/`excludeTools` (excludeTools wins)
3. Name sanitization: invalid chars → `_`, max 128 chars
4. Conflict resolution: first server wins unprefixed; later → `serverName__toolName`
5. Wrap in [[DiscoveredMCPTool]]
6. Register in [[ToolRegistry]]

## Configuration (`settings.json`)

```json
{
  "mcpServers": {
    "serverName": {
      "command": "path/to/server",
      "args": ["--arg1"],
      "url": "http://localhost:8080/sse",
      "httpUrl": "http://localhost:3000/mcp",
      "headers": {},
      "env": { "API_KEY": "$MY_TOKEN" },
      "timeout": 30000,
      "trust": false,
      "includeTools": ["tool1"],
      "excludeTools": ["dangerous_tool"],
      "oauth": { "enabled": true, "clientId": "...", ... }
    }
  }
}
```

## OAuth Support

- **Auto-discovery**: 401 → `www-authenticate` → discover endpoints → browser auth → token storage
- **Token storage**: `~/.gemini/mcp-oauth-tokens.json`
- **Token refresh**: Automatic on expiry
- **Auth command**: `/mcp auth serverName`

## DiscoveredMCPTool Class

Extends [[BaseTool]]:
- **Confirmation**: Trust bypass → allowlist → user confirmation ("always allow" option)
- **Execution**: `Promise.race()` of MCP call, abort signal, timeout
- **Name gen**: `generateValidName()` for Gemini + Claude compatibility
- **Cloning**: `clone()` for cross-[[ToolRegistry]] sharing

## Global State (Module-level Maps)

`serverStatuses`, `activeMcpClients`, `globalDiscoveredTools`, `globalDiscoveredResources`, `serverToolCounts`, `serverToolNames`, `mcpServerRequiresOAuth`

## VSCode Multi-Instance Handling

- `mcpDiscoveryTriggered` flag prevents duplicate spawning
- `globalDiscoveredTools` cache for subsequent AIService instances
- `syncMcpToolsToRegistry()` / `syncMcpResourcesToRegistry()` clone tools to new registries

## Real-Time Status Display

App.tsx listens via `addMCPStatusChangeListener` → React re-render: `"0/3 MCP servers (connecting...)"` → `"3 MCP servers"`

## Related Pages

- [[core-module]]
- [[tools-system]]
- [[source-01-architecture]]
