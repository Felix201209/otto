# Easy Code — CLI Module Facts

> Auto-generated from codebase analysis on 2026-04-09. Immutable source document.

## Entry Point

`packages/cli/index.ts` — shebang-based entry (`#!/usr/bin/env node`) calling `main()` from `src/gemini.tsx`.

## Main Function: `src/gemini.tsx`

The `main()` function is ~600 lines and orchestrates:

1. Console clear + startup timing diagnostics
2. Error handler setup (`unhandledRejection`)
3. Environment/settings loading
4. Skills system initialization
5. Extension loading (dynamic commands)
6. Argument parsing (two-pass: first for `--workdir`, second with extensions)
7. Forced update checks
8. Session management (create/continue/load)
9. Authentication validation
10. Config initialization + model diagnostics
11. Theme loading
12. Sandbox launching (if configured)
13. Interactive mode → Ink/React `<AppWrapper>` rendering
14. Non-interactive mode → `runNonInteractive()` pipeline

## Directory Layout

| Directory | Responsibility |
|-----------|---------------|
| `ui/` | Terminal UI (Ink/React) — `App.tsx`, `colors.ts`, `types.ts`, `constants.ts` |
| `ui/components/` | 60+ UI components — `InputPrompt.tsx`, `Header.tsx`, `Footer.tsx`, `WelcomeScreen.tsx`, `ThemeDialog.tsx`, `ModelDialog.tsx`, `AuthDialog.tsx` |
| `ui/hooks/` | React hooks — `useGeminiStream.ts`, `useTerminalSize.ts`, `useThemeCommand.ts`, `useSlashCommandProcessor.ts` |
| `ui/commands/` | 50+ slash commands — `modelCommand.ts`, `memoryCommand.ts`, `mcpCommand.ts`, `themeCommand.ts`, `statsCommand.ts`, `refineCommand.ts` |
| `ui/themes/` | Theme management — `theme-manager.ts` + theme definitions |
| `ui/contexts/` | React contexts — shared state providers |
| `ui/editors/` | Built-in editors |
| `ui/utils/` | UI utilities — `i18n.ts`, `textTruncator.ts`, `clipboardUtils.ts`, `updateCheck.ts`, `ConsolePatcher.ts` |
| `config/` | CLI configuration — `config.ts`, `settings.ts`, `auth.ts`, `extension.ts`, `prompt-extensions.ts`, `customModelsStorage.ts` |
| `commands/` | Top-level commands — `checkpoint.ts`, `extensions.tsx` |
| `services/` | CLI-level services |
| `auth/` | CLI auth flow |
| `acp/` | Agent Communication Protocol peer — `acpPeer.ts` |
| `remote/` | Remote/cloud mode — `remoteServer.ts` |
| `utils/` | CLI utilities — `cleanup.ts`, `sandbox.ts`, `readStdin.ts`, `silentMode.ts`, `audioNotification.ts`, `sessionExport.ts`, `version.ts` |
| `patches/` | Runtime patches for dependencies |
| Root files | `gemini.tsx`, `nonInteractiveCli.ts`, `nonInteractiveSlashCommandHandler.ts` |

## Key Components

| Component | Pattern | Role |
|-----------|---------|------|
| `AppWrapper` / `App` | React Component Tree | Root Ink/React component managing all UI state |
| `main()` | Orchestrator | Bootstrap, config, mode selection |
| `useGeminiStream` | Custom Hook | Manages streaming AI responses and tool call display |
| `useSlashCommandProcessor` | Custom Hook | Handles 50+ slash commands |
| Slash Commands | Command Pattern | Each in `ui/commands/` implements a handler |
| `themeManager` | Singleton | Theme loading and switching |
| Extension system | Plugin | Dynamic loading via `loadExtensions()` with TOML prompt extensions |
| `nonInteractiveCli` | Pipeline | Handles piped/`-p` flag non-interactive execution |
| Window title management | Observer | Dynamic title updates with checkpoint summaries, icon animation |

## Two Operational Modes

1. **Interactive mode**: Full Ink/React UI with streaming, slash commands, themes, tool confirmations
2. **Non-interactive mode**: Piped input or `-p` flag, headless execution with structured output
