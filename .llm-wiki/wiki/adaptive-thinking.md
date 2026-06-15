---
type: entity
date: 2026-05-30
tags: [thinking, reasoning, models, claude, config]
sources: [packages/core/src/core/customModelAdapter.ts, packages/cli/src/ui/commands/thinkingCommand.ts, packages/cli/src/ui/components/ReasoningDisplay.tsx]
---

# Adaptive Thinking Mode & Reasoning

Easy Code features an advanced Adaptive Thinking Mode that provides a unified, highly optimized interface for managing LLM reasoning capabilities (such as Anthropic's Claude Thinking Budget, OpenAI's reasoning effort, and Google's Gemini thinking budget parameters).

## The Core Concept

Modern frontier models support "thinking/reasoning" before outputting their final answers. However, each provider implements this differently:
- **OpenAI**: Uses `reasoning_effort` (`none`, `low`, `medium`, `high`, `xhigh`).
- **Google Gemini**: Uses `thinking_budget` configuration.
- **Anthropic Claude**: Uses `thinking` with explicit `max_tokens` budgets.

Easy Code maps these distinct specifications into a unified **Thinking Effort Selector** that works across all supported models.

```
User Selection (Thinking / Effort level)
  → ThinkingCommand / VSCode Webview
  → Transformed into provider-specific API parameters
  → Captured reasoning tokens streamed into ReasoningDisplay.tsx
```

## UI & UX Implementations

Reasoning tokens can bloat the chat screen. Easy Code renders reasoning beautifully:
1. **Terminal / CLI UI**:
   - Displays a custom `🧠` Brain icon in front of the active model's name in the footer.
   - Collapses live thinking thoughts into an elegant, styled inline markdown block (`ReasoningDisplay.tsx`).
2. **VS Code WebView**:
   - Merges the Thinking Selector directly into the Model Selector panel to conserve toolbar space.
   - Features a high-fidelity vector outline SVG **BrainIcon** that actively changes color-saturation levels based on the configured thinking effort.

## Defensive Hardening & Fallbacks

Handling reasoning streams is prone to downstream API errors. The engine implements critical security checks:
- **Claude Haiku Bypass**: Thinking budgets are completely bypassed for Claude Haiku models to prevent `400 Bad Request` errors (since Haiku lacks a thinking engine).
- **History Sanitization (`cleanContents`)**: Proxy models (like Kimi, Mythos, or Kimi-compatible API gateways) often crash with `400 errors` if they receive history blocks containing separate raw reasoning parts. `customModelAdapter.ts` scans the history and automatically consolidates reasoning/thought parts back into the primary text message blocks before transport.
- **Persistent Storage**: Saves the user's active thinking configuration to their global settings, maintaining consistency across terminal restarts and workspace instances.

## Related Pages
- [[core-module]]
- [[cli-module]]
- [[tools-system]]
