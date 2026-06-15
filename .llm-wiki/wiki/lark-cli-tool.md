---
type: entity
date: 2026-05-30
tags: [tools, lark, feishu, cli]
sources: [packages/core/src/tools/lark-cli.ts, packages/core/src/tools/lark-cli.test.ts]
---

# Lark CLI Tool (`lark_cli`)

The `lark_cli` tool is a high-level, unified AI-native wrapper around the official `lark-cli` tool. It provides the agent with deep access to 18+ business domains in Feishu (Lark) including Calendar, Documents, Spreadsheets, IM, Tasks, Mail, Wiki, and more.

## Architecture & Lifecycles

```
AI Call (lark_cli)
  → LarkCliTool.execute()
  → Spawns lark-cli binary
  → Live stdout stream matching (AUTH_URL_REGEX)
  → (if browser auth required) Takeover & prompt user with dynamic link
  → (if normal execution) Stream results live with 500ms throttling
```

### Key Technical Aspects

1. **Live Output Throttling**: Command execution output is throttled using `OUTPUT_UPDATE_INTERVAL_MS = 500` before updating the terminal UI or Feishu status cards, preventing UI rendering lag.
2. **Dynamic OAuth Takeover**:
   - When `lark-cli` requires credentials, it outputs login URLs. `LarkCliTool` intercepts these in real-time using `AUTH_URL_REGEX`.
   - The tool streams the verification URL directly to the user in the CLI. The user completes authentication in their browser, and `LarkCliTool` automatically resumes execution.
3. **Generous Watchdog Timeout**: Legitimate logins can take time. Rather than killing processes via the default shell 5-minute timeout, the `lark_cli` tool uses `FALLBACK_TIMEOUT_MS = 15 * 60 * 1000` (15 minutes) specifically for auth operations, protecting against hung processes while supporting real-world logins.

## Critical Guidelines for the AI Agent

### 📝 Uploading Long Document Content (>500 Characters)
When creating or updating Feishu Docs, **NEVER pass inline text directly** if the content is long. Inline text exceeds shell argument bounds and will be silently dropped or truncated.
- **Rule**: Write the document to a temporary local file first.
- **Syntax**: Use `@<relative-path>` (e.g., `--content "@temp/file.md"` or `--markdown "@temp/file.md"`).

## Domain Cheatsheet & Code Patterns

### 📅 Calendar
- **Fetch agenda**: `command="calendar +agenda"`
- **Create event**: `command="calendar +create"` with args `["--summary", "Title", "--start", "ISO_START", "--end", "ISO_END"]`

### 📄 Documents (Docs)
- **Create Doc (Recommended)**: `command="docs +create"` with args `["--api-version", "v2", "--title", "My Title", "--content", "@temp/doc.md", "--doc-format", "markdown"]`
- **Update Doc**: `command="docs +update"` with args `["--api-version", "v2", "--doc", "<token>", "--markdown", "@temp/doc.md", "--mode", "overwrite"]`

### 📊 Sheets (Spreadsheets)
- **Read cells**: `command="sheets +read"` with args `["--spreadsheet-token", "<token>", "--range", "A1:D10"]`
- **Write cells**: `command="sheets +write"` with args `["--spreadsheet-token", "<token>", "--range", "A1", "--value", "data"]`

### 💬 IM (Messaging)
- **Send message**: `command="im +messages-send"` with args `["--receive-id-type", "chat_id", "--receive-id", "<id>", "--msg-type", "text", "--content", "{\"text\":\"Hello\"}"]`

### ☁️ Drive (Cloud Drive)
- **Upload file**: `command="drive +upload"` with args `["--file", "relative-path"]`
- **Download file**: `command="drive +download"` with args `["--file-token", "<token>", "--file", "output.bin"]`

## Related Pages
- [[feishu-integration]]
- [[tools-system]]
