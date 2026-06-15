---
type: entity
date: 2026-04-09
tags: [tools, registry, execution, tool-system]
sources: [raw/04-tools-system.md, raw/02-core-module.md]
---

# Tools System

> The extensible tool framework powering Easy Code's AI agent capabilities.

## Overview

工具系统是 Easy Code 的核心能力层。AI 模型通过 FunctionCall 请求工具执行，[[ToolExecutionEngine]] 管理执行状态机，[[ToolRegistry]] 管理工具注册与发现。

## Architecture

```
AI FunctionCall → ToolExecutionEngine → ToolRegistry.getTool()
  → Tool.validateToolParams() → shouldConfirmExecute() → execute()
  → ToolResult → FunctionResponse back to AI
```

## Components

| Component | Role |
|-----------|------|
| [[ToolRegistry]] | Tool registration, MCP sync, name sanitization |
| [[ToolExecutionEngine]] | State machine (validating → scheduled → executing → success/error) |
| [[BaseTool]] | Abstract base class for all tools |
| [[DiscoveredMCPTool]] | Wrapper for [[mcp-system]] tools |

## 32 Built-in Tools

| Category | Count | Tools |
|----------|-------|-------|
| File System | 8 | list_directory, read_file, write_file, replace, glob, search_file_content, read_many_files, delete_file |
| Advanced Edit | 3 | multiedit, patch, batch |
| Execution & Sub-agent | 2 | run_shell_command, task ([[SubAgent]]) |
| Web | 2 | web_fetch, google_web_search |
| Memory/Todo | 2 | save_memory, todo_write |
| Code Intelligence | 4 | lsp, read_lints, lint_fix, codesearch |
| Skills | 3 | list_available_skills, get_skill_details, use_skill |
| PPT | 2 | ppt_outline, ppt_generate |
| Workspace & Utilities | 6 | ask_user_question, [[lark-cli-tool]] (`lark_cli`), local_time, goal_achieved, image_reader, audio_reader |

## Confirmation Types

`edit` (file diff), `exec` (shell command), `mcp` (server+tool), `info` (URLs), `delete` (file content)

## Integration Points

- [[hooks-system]]: BeforeTool/AfterTool events wrap tool execution
- [[mcp-system]]: Dynamic tool discovery from MCP servers
- [[core-module]]: Registration via `config.ts` → `registerCoreTool()`

## Sources

- [[source-04-tools-system]]
- [[source-02-core-module]]
