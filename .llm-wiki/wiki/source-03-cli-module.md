---
type: source-summary
date: 2026-04-09
tags: [cli, module, ink, react, terminal-ui, slash-commands]
source: raw/03-cli-module.md
---

# Source Summary: CLI Module

> Summary of [raw/03-cli-module.md](../raw/03-cli-module.md)

## Entry Point

`packages/cli/index.ts` — shebang-based entry calling `main()` from `src/gemini.tsx`.

## Bootstrap Sequence (`main()` ~600 lines)

1. Console clear + startup timing
2. Error handler setup
3. Environment/settings loading
4. [[skills-system]] initialization
5. Extension loading (dynamic commands)
6. Argument parsing (two-pass: first `--workdir`, second with extensions)
7. Forced update checks
8. Session management (create/continue/load)
9. Authentication validation
10. Config initialization + model diagnostics
11. Theme loading
12. Sandbox launching (if configured)
13. Mode selection → Interactive or Non-interactive

## Directory Layout

| Directory | Responsibility |
|-----------|---------------|
| `ui/` | Terminal UI (Ink/React) — App.tsx, colors, types, constants |
| `ui/components/` | 60+ UI components — InputPrompt, Header, Footer, WelcomeScreen, ThemeDialog, ModelDialog |
| `ui/hooks/` | React hooks — useGeminiStream, useTerminalSize, useSlashCommandProcessor |
| `ui/commands/` | 50+ slash commands — model, memory, mcp, theme, stats, refine |
| `ui/themes/` | Theme management — theme-manager + definitions |
| `ui/contexts/` | React contexts — shared state providers |
| `config/` | CLI configuration — settings, auth, extensions, custom models storage |
| `commands/` | Top-level commands — checkpoint, extensions |
| `acp/` | Agent Communication Protocol peer |
| `remote/` | Remote/cloud mode |
| `utils/` | CLI utilities — cleanup, sandbox, readStdin, audioNotification, sessionExport |

## Key Components

| Component | Pattern | Role |
|-----------|---------|------|
| AppWrapper / App | React Component Tree | Root Ink/React component |
| `main()` | Orchestrator | Bootstrap, config, mode selection |
| useGeminiStream | Custom Hook | Manages streaming AI responses |
| useSlashCommandProcessor | Custom Hook | Handles 50+ slash commands |
| themeManager | Singleton | Theme loading and switching |
| Extension system | Plugin | Dynamic loading via `loadExtensions()` with TOML prompt extensions |
| nonInteractiveCli | Pipeline | Handles piped/`-p` flag execution |

## Two Operational Modes

1. **Interactive**: Full Ink/React UI with streaming, slash commands, themes, tool confirmations
2. **Non-interactive**: Piped input or `-p` flag, headless execution with structured output

## Related Pages

- [[source-01-architecture]]
- [[core-module]]
- [[tools-system]]
- [[skills-system]]
