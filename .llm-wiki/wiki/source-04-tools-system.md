---
type: source-summary
date: 2026-04-09
tags: [tools, tool-registry, execution-engine, built-in-tools]
source: raw/04-tools-system.md
---

# Source Summary: Tools System

> Summary of [raw/04-tools-system.md](../raw/04-tools-system.md)

## Architecture

```
User Prompt → AI API → FunctionCall → ToolExecutionEngine → ToolRegistry.getTool()
  → Tool instance → validateToolParams() → shouldConfirmExecute() → execute()
  → ToolResult → FunctionResponse back to AI API
```

## Core Files

| File | Role |
|------|------|
| `tools/tools.ts` | Tool interface, [[BaseTool]], ToolResult, Icon enum |
| `tools/tool-registry.ts` | [[ToolRegistry]] — registration, MCP sync, sanitization |
| `core/toolExecutionEngine.ts` | [[ToolExecutionEngine]] — state machine |
| `core/coreToolScheduler.ts` | Bridges engine with UI |
| `tools/modifiable-tool.ts` | ModifiableTool — "modify with editor" flow |
| `tools/mcp-tool.ts` | [[DiscoveredMCPTool]] — MCP wrapper |
| `tools/mcp-client.ts` | [[mcp-client]] — server connections |

## 27 Built-in Tools (7 categories)

### File System (8)
`list_directory`, `read_file`, `write_file`, `replace` (EditTool), `glob`, `search_file_content` (GrepTool), `read_many_files`, `delete_file`

### Advanced Edit (3)
`multiedit`, `patch`, `batch` (up to 20 independent calls)

### Execution (2)
`run_shell_command` (ShellTool), `task` (TaskTool/[[SubAgent]], CLI-only)

### Web (2)
`web_fetch`, `google_web_search`

### Memory & Todo (2)
`save_memory`, `todo_write`

### Code Intelligence (4)
`lsp`, `read_lints`, `lint_fix`, `codesearch` (via Exa MCP API)

### Skills (3)
`list_available_skills`, `get_skill_details`, `use_skill`

### PPT (2)
`ppt_outline`, `ppt_generate`

### Dynamic Tools
- `DiscoveredTool` — from external `toolDiscoveryCommand`
- [[DiscoveredMCPTool]] — from [[mcp-system]] servers

## Tool Definition Pattern

1. Parameter interface (`export interface XToolParams`)
2. Class extends `BaseTool<Params, ToolResult>`
3. Static `Name` property (snake_case)
4. Constructor: name, displayName, description, icon, parameterSchema (OpenAPI 3.0)
5. `validateToolParams()` → SchemaValidator + custom checks
6. `getDescription()` — pre-execution UI description
7. `shouldConfirmExecute()` → false (auto) or confirmation details
8. `execute()` → core logic → `ToolResult`

## Execution State Machine

```
FunctionCall → validating → scheduled → shouldConfirmExecute()
  → awaiting_approval or executing
  → Cancel → cancelled / Proceed → executing / Modify → editor → executing
  → execute() → success or error
```

## Confirmation Types

| Type | Used By |
|------|---------|
| `edit` | EditTool, WriteFileTool, MultiEditTool, PatchTool |
| `exec` | ShellTool |
| `mcp` | [[DiscoveredMCPTool]] |
| `info` | WebFetchTool |
| `delete` | DeleteFileTool |

## Notable Details

- EditTool has multi-stage edit correction using AI to refine `old_string` on match failure
- `FileOperationQueue` prevents same-file race conditions
- MCPResponseGuard limits responses to 100KB
- TodoWriteTool stores in module-level variable (lost on restart)
- ShellTool supports Ctrl+B for background execution
- `bash` → `run_shell_command` alias for backward compat
- Tool name validation: `^[a-zA-Z0-9_-]{1,128}$`; non-ASCII → MD5 hash

## Related Pages

- [[core-module]]
- [[mcp-system]]
- [[hooks-system]] (BeforeTool, AfterTool events)
- [[source-01-architecture]]
