---
type: entity
date: 2026-05-30
tags: [compression, context, micro-compact, token-optimization]
sources: [packages/core/src/services/compressionService.ts, packages/core/src/services/microCompactService.ts, packages/core/src/services/postCompactRestorationService.ts]
---

# Context Compression & Restoration

Context Compression is Easy Code's automated, high-reliability memory pruning mechanism. It prevents large LLM sessions from exceeding their Context Window limit while preserving crucial state and reasoning context.

## The Challenge of Context Bloat

As the AI agent calls tools, processes code files, and receives linter messages, the token count grows exponentially. Leaving this unchecked leads to:
1. **Model Crash (400 Bad Request)**: Exceeding maximum context limits.
2. **Degraded Quality**: "Loss in the middle" where models overlook older instructions.
3. **Extreme Cost**: Swallowing hundreds of thousands of tokens per prompt.

## Architectural Mechanisms

Easy Code features a dual-layer compression pipeline consisting of **CompressionService** and **MicroCompactService**:

```
Token Threshold Tripped (or >6m) → MicroCompactService
  → Run Two-Phase Compactor (via fast flash-model)
  → Truncate stale tool results & summarize chat turns
  → Ensure strict message role alternating
  → PostCompactRestoration (Injects goals & live states back)
```

### 1. Manual vs. Auto Compression
- **Manual Compression (`/compress` or `/compact`)**: Users can manually trigger a full context prune at any point.
- **Automated Micro-Compression (`microCompactService.ts`)**: Silently checks session token count and duration between turns. Automatically triggers when:
  - Session duration exceeds 6 minutes.
  - Active token count crosses progressive limit gates (e.g. 80% capacity).

### 2. Safeguards & Formatting Hardening
Compacting an active agent's history is mathematically and syntactically dangerous. The engine implements strict formatting rules:
- **Assistant Prefill Guard**: Ensures that the final message in the compacted history is written from the `user` role. This prevents Anthropic Claude APIs from crashing with `400 prefill errors`.
- **Alternating Roles Guarantee**: Ensures that the message chain strictly alternates (`user` -> `assistant` -> `user`). If consecutive roles match, the system merges them or inserts clean synthetic prompts.
- **Infinite Loop Circuit Breaker**: If compression fails to reduce the token count significantly, a progressive circuit breaker engages, dropping older non-critical messages to protect the live session.

### 3. Post-Compact Restoration
After the compression service reduces the message chain to a brief summary, the **PostCompactRestorationService** reconstructs live runtime states:
- Re-injects the active [[goal-driven-mode]] contract and prompt.
- Re-establishes the current files-in-context bindings.
- Restores localized system configurations without polluting the model's chat history.

## Related Pages
- [[core-module]]
- [[goal-driven-mode]]
- [[tools-system]]
