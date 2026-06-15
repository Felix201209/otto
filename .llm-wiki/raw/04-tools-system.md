# Easy Code — Tools System Facts

> Auto-generated from codebase analysis on 2026-04-09. Immutable source document.

## Architecture

```
User Prompt → Gemini API (FunctionDeclaration schemas) → FunctionCall response
  → ToolExecutionEngine → ToolRegistry.getTool(name) → Tool instance
  → validateToolParams() → shouldConfirmExecute() → execute() → ToolResult
  → FunctionResponse back to Gemini API
```

## Core Files

| File | Role |
|------|------|
| `tools/tools.ts` | `Tool` interface, `BaseTool` abstract class, `ToolResult`, confirmation types, `Icon` enum |
| `tools/tool-registry.ts` | `ToolRegistry` — registration, MCP sync, schema sanitization |
| `core/toolExecutionEngine.ts` | State machine for tool calls (validating→scheduled→executing→success/error/cancelled) |
| `core/coreToolScheduler.ts` | Bridges engine with UI, manages completion handlers |
| `core/toolSchedulerAdapter.ts` | Adapter interface for UI decoupling |
| `tools/modifiable-tool.ts` | `ModifiableTool` interface — supports "modify with editor" flow |
| `tools/mcp-tool.ts` | `DiscoveredMCPTool` — wrapper for MCP server tools |
| `tools/mcp-client.ts` | MCP client — connects to servers, discovers tools/resources |

## Complete Built-in Tool List (27 tools)

### File System Tools (8)

| Tool API Name | Class | Display | Confirmation | Description |
|---------------|-------|---------|-------------|-------------|
| `list_directory` | `LSTool` | ReadFolder | No | Lists directory contents with ignore patterns |
| `read_file` | `ReadFileTool` | ReadFile | No | Reads single file (text/image/PDF), offset/limit |
| `write_file` | `WriteFileTool` | WriteFile | Yes (diff) | Writes content, creates parent dirs |
| `replace` | `EditTool` | Edit | Yes (diff) | Precise text replacement with multi-stage edit correction |
| `glob` | `GlobTool` | FindFiles | No | Finds files by glob, sorted by mtime |
| `search_file_content` | `GrepTool` | SearchText | No | Regex search using git grep/ripgrep |
| `read_many_files` | `ReadManyFilesTool` | ReadManyFiles | No | Reads multiple files/globs |
| `delete_file` | `DeleteFileTool` | DeleteFile | Yes (delete) | Safely deletes text files with content preservation |

### Advanced Edit Tools (3)

| Tool API Name | Class | Display | Confirmation | Description |
|---------------|-------|---------|-------------|-------------|
| `multiedit` | `MultiEditTool` | Multi Edit | Yes (diff) | Multiple sequential edits |
| `patch` | `PatchTool` | Patch | Yes (diff) | Standard patch format |
| `batch` | `BatchTool` | Batch | No | Up to 20 independent tool calls |

### Execution Tools (2)

| Tool API Name | Class | Display | Confirmation | Description |
|---------------|-------|---------|-------------|-------------|
| `run_shell_command` | `ShellTool` | Shell | Yes (exec) | Shell commands with background support |
| `task` | `TaskTool` | Task | No | Spawns SubAgent (CLI mode only) |

### Web Tools (2)

| Tool API Name | Class | Display | Confirmation | Description |
|---------------|-------|---------|-------------|-------------|
| `web_fetch` | `WebFetchTool` | WebFetch | Yes (info) | Fetches/processes URLs via Gemini API |
| `google_web_search` | `WebSearchTool` | Web Search | No | Google search via Gemini API grounding |

### Memory & Todo Tools (2)

| Tool API Name | Class | Display | Confirmation | Description |
|---------------|-------|---------|-------------|-------------|
| `save_memory` | `MemoryTool` | Memory | No | Saves facts to `~/.easycode-user/EASYCODE.md` |
| `todo_write` | `TodoWriteTool` | TodoWrite | No | In-memory todo list management |

### Code Intelligence Tools (4)

| Tool API Name | Class | Display | Confirmation | Description |
|---------------|-------|---------|-------------|-------------|
| `lsp` | `LspTool` | LSP Tool | No | LSP operations (go-to-def, references, hover, symbols) |
| `read_lints` | `ReadLintsTool` | ReadLints | No | Reads linter diagnostics (VSCode callback) |
| `lint_fix` | `LintFixTool` | LintFix | No | Auto-fixes linter errors (VSCode callback) |
| `codesearch` | `CodeSearchTool` | Code Search | No | External code search via Exa MCP API |

### Skills System Tools (3)

| Tool API Name | Class | Display | Confirmation | Description |
|---------------|-------|---------|-------------|-------------|
| `list_available_skills` | `ListSkillsTool` | List Available Skills | No | Lists installed/enabled skills |
| `get_skill_details` | `GetSkillDetailsTool` | Get Skill Details | No | Gets skill info |
| `use_skill` | `UseSkillTool` | Use Skill | No | Activates a skill |

### PPT Tools (2)

| Tool API Name | Class | Display | Confirmation | Description |
|---------------|-------|---------|-------------|-------------|
| `ppt_outline` | `PptOutlineTool` | PPT大纲管理 | No | PPT outline management |
| `ppt_generate` | `PptGenerateTool` | PPT Generate | Yes | Submits outline, starts generation |

### Dynamic Tool Types

| Type | Class | Source |
|------|-------|--------|
| Command-discovered | `DiscoveredTool` | External `toolDiscoveryCommand` |
| MCP-discovered | `DiscoveredMCPTool` | MCP servers in config |

## Tool Definition Pattern

Every tool follows:
1. Parameter interface (`export interface XToolParams`)
2. Class extends `BaseTool<Params, ToolResult>`
3. Static `Name` property (API name, snake_case)
4. Constructor: name, displayName, description, icon, parameterSchema (OpenAPI 3.0)
5. `validateToolParams()` — `SchemaValidator.validate()` + custom checks
6. `getDescription()` — pre-execution description for UI
7. `shouldConfirmExecute()` — returns false (auto) or confirmation details
8. `execute()` — core logic, returns `ToolResult`

## ToolResult Structure

```typescript
{
  llmContent: PartListUnion;        // Goes back to Gemini as FunctionResponse
  returnDisplay: ToolResultDisplay;  // Shown to user
  summary?: string;                  // One-line summary
  backgroundTaskId?: string;
  isBackgroundTask?: boolean;
  visualDisplay?: VisualDisplay;     // TodoDisplay, SubAgentDisplay, FileDiff, McpThinkingDisplay
}
```

## Execution State Machine

```
FunctionCall → [validating] → [scheduled] → shouldConfirmExecute()
  → [awaiting_approval] or [executing]
  → user: Cancel → [cancelled] / Proceed → [executing] / Modify → editor → [executing]
  → execute() → [success] or [error]
```

## Confirmation Types

| Type | Used By | Shows |
|------|---------|-------|
| `edit` | EditTool, WriteFileTool, MultiEditTool, PatchTool | File diff |
| `exec` | ShellTool | Command + danger warning |
| `mcp` | DiscoveredMCPTool | Server + tool name |
| `info` | WebFetchTool | Prompt + URLs |
| `delete` | DeleteFileTool | Path + content + size |

## Registration Flow

Tools registered in `config.ts` via `registerCoreTool()`:
- Checks `coreTools` whitelist and `excludeTools` blacklist
- `TaskTool` only registered in CLI mode (not VSCode)
- After built-in tools: `registry.discoverCommandLineTools()` for external tools
- Tool name validation: `^[a-zA-Z0-9_-]{1,128}$`; non-ASCII names get MD5 hashing
- `bash` → `run_shell_command` alias for backward compatibility

## Notable Implementation Details

- `EditTool` has multi-stage edit correction using Gemini to refine `old_string` on match failure
- `FileOperationQueue` ensures same-file edits execute sequentially (no race conditions)
- `MCPResponseGuard` limits MCP tool responses to 100KB
- `TodoWriteTool` stores todos in module-level variable (lost on restart)
- `ShellTool` supports Ctrl+B to move running commands to background
- Schema sanitization: removes unsupported `format` values, handles `anyOf`/`default` conflicts, tolerant mode for small models
