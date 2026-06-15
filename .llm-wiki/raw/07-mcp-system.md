# Easy Code — MCP System Facts

> Auto-generated from codebase analysis on 2026-04-09. Immutable source document.

## Architecture: Discovery + Execution

Location: `packages/core/src/tools/` (mcp-client.ts ~900 lines, mcp-tool.ts ~350 lines) + `packages/core/src/mcp/` (OAuth)

```
MCP System
├── mcp-client.ts        → Connection management, discovery, OAuth, status tracking
├── mcp-tool.ts          → DiscoveredMCPTool wrapping MCP tools as native tools
├── mcp/oauth-provider.ts    → OAuth authentication provider
├── mcp/oauth-utils.ts       → OAuth utility functions
├── mcp/oauth-token-storage.ts → Token persistence
├── mcp/login-provider.ts    → Login flow provider
└── tool-registry.ts         → Central tool registration
```

## Two-Phase Loading

1. **Phase 1 (Synchronous)**: Load core built-in tools + CLI custom tools → CLI immediately usable
2. **Phase 2 (Async Background)**: Connect to MCP servers sequentially → tools appear as connections complete

### Sequential Startup Optimization

Servers start one at a time with `setImmediate()` yield between each (instead of `Promise.all()`).
Per-server blocking: ~100-200ms (down from ~500ms parallel). Keeps UI responsive.

## Transport Mechanisms

| Transport | Trigger | Communication |
|-----------|---------|--------------|
| Stdio | `command` field in config | Spawns subprocess, pipes stdin/stdout |
| SSE | `url` field in config | Server-Sent Events HTTP |
| Streamable HTTP | `httpUrl` field in config | HTTP streaming |

## Connection Lifecycle

1. Status → `CONNECTING`
2. Transport selection (based on config properties)
3. Client creation (`Client` from `@modelcontextprotocol/sdk`)
4. Connect with timeout (default 30s connect, 10min request)
5. Discovery (prompts, resources, tools)
6. Registration in `ToolRegistry`
7. Status → `CONNECTED` or `DISCONNECTED`

## Tool Discovery Pipeline

1. Fetch declarations from server
2. Filter via `includeTools`/`excludeTools` (excludeTools takes precedence)
3. Name sanitization: invalid chars → `_`, ensure starts with letter/underscore, max 128 chars
4. Conflict resolution: first server wins unprefixed; later get `serverName__toolName`
5. Wrap in `DiscoveredMCPTool`
6. Register in `ToolRegistry`

## Configuration (`settings.json`)

```json
{
  "mcpServers": {
    "serverName": {
      "command": "path/to/server",
      "args": ["--arg1"],
      "url": "http://localhost:8080/sse",
      "httpUrl": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ..." },
      "env": { "API_KEY": "$MY_TOKEN" },
      "cwd": "./server-dir",
      "timeout": 30000,
      "trust": false,
      "includeTools": ["tool1"],
      "excludeTools": ["dangerous_tool"],
      "authProviderType": "dynamic_discovery",
      "oauth": {
        "enabled": true,
        "clientId": "...",
        "authorizationUrl": "...",
        "tokenUrl": "...",
        "scopes": ["..."],
        "redirectUri": "http://localhost:7777/oauth/callback"
      }
    }
  }
}
```

## OAuth Support

- **Auto-discovery**: 401 → extract `www-authenticate` → discover endpoints → browser auth → token storage
- **Token storage**: `~/.gemini/mcp-oauth-tokens.json`
- **Token refresh**: Automatic when expired (if refresh token available)
- **Auth command**: `/mcp auth serverName`

## Key Exports from mcp-client.ts

| Symbol | Type | Purpose |
|--------|------|---------|
| `discoverMcpTools()` | Function | Main entry: sequential startup + discovery |
| `connectAndDiscover()` | Function | Single server connect → discover → register |
| `connectToMcpServer()` | Function | Create transport + connect with timeout |
| `MCPServerStatus` | Enum | `DISCONNECTED`, `CONNECTING`, `CONNECTED` |
| `MCPDiscoveryState` | Enum | `NOT_STARTED`, `IN_PROGRESS`, `COMPLETED` |
| `addMCPStatusChangeListener()` | Function | Real-time status updates for UI |
| `getAllMCPServerStatuses()` | Function | All server connection states |
| `syncMcpToolsToRegistry()` | Function | Sync cached tools to new ToolRegistry (VSCode multi-instance) |
| `unloadMcpServer()` | Function | Disconnect + cleanup + clear caches |
| `waitForMCPDiscoveryComplete()` | Function | Await discovery with timeout |

## Global State (Module-level Maps)

| Map | Purpose |
|-----|---------|
| `serverStatuses` | Connection status per server |
| `activeMcpClients` | Active `Client` instances |
| `globalDiscoveredTools` | Tool cache for cross-registry sync |
| `globalDiscoveredResources` | Resource cache per server |
| `serverToolCounts` / `serverToolNames` | Quick-access metadata |
| `mcpServerRequiresOAuth` | OAuth requirement per server |

## DiscoveredMCPTool Class

Extends `BaseTool`:
- **Confirmation**: Trust bypass → allowlist → user confirmation (with "always allow server/tool")
- **Execution**: `Promise.race()` of MCP call, abort signal, and timeout
- **Name generation**: `generateValidName()` for Gemini + Claude API compatibility
- **Cloning**: `clone()` for cross-ToolRegistry sharing
- **Schema**: Returns `parametersJsonSchema` as function declaration

## Real-Time Status Display

- `App.tsx` listens to `addMCPStatusChangeListener` → React re-render
- `ContextSummaryDisplay.tsx` shows: `0/3 MCP servers (connecting...)` → `3 MCP servers`

## VSCode Multi-Instance Handling

- `mcpDiscoveryTriggered` flag prevents duplicate MCP process spawning
- `globalDiscoveredTools` cache for subsequent `AIService` instances
- `waitForMCPDiscoveryComplete()` with configurable timeout
- `syncMcpToolsToRegistry()` / `syncMcpResourcesToRegistry()` clone tools to new registries

## Schema Processing

- `LenientJsonSchemaValidator` wraps AJV with fallback to no-op on errors
- Strips `$schema`, `additionalProperties` for Gemini compatibility
- Complex `$defs`/`$ref` schemas logged but accepted on failure
