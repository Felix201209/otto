---
type: entity
date: 2026-06-05
tags: [goal, watchdog, agent, commands]
sources: [packages/cli/src/ui/commands/goalCommand.ts, packages/cli/src/ui/hooks/useGoalActive.ts, packages/cli/src/ui/hooks/useGoalWizard.ts]
---

# Goal-Driven Mode (`/goal`)

Goal-Driven Mode is a specialized running state in Easy Code that commits the AI agent to a strict, multi-step "goal contract". The agent is tasked with systematically working on a specified problem until its objective completion criteria are fully met.

## Purpose & Core Philosophy

AI agents can easily stall, wander off-task, or give up prematurely when executing complex, multi-file software engineering tasks. Goal-Driven Mode mitigates this by:
1. **Contractual Constraints**: Restricting the AI's environment with strict "forbidden items" and defining explicit "completion criteria".
2. **Persistence Discipline**: Banning the agent from stopping until either the minimum working hours floor has been reached, or the completion criteria are fully satisfied.
3. **Structured Goal Continuation**: Automatically injecting the goal description and current progress into the LLM prompt context at each conversation turn, especially during context compressions.

## Architectural Components

### 1. GoalWizard Dialog
Launched via `/goal` or `/goal new`. Collects:
- Task Description (What needs to be achieved)
- Forbidden/Sensitive Actions (e.g., "no force push", "do not modify certain directories")
- Objective Completion Criteria (Explicit definition of "done")
- Minimum Working Time / Intensity Gear

### 2. The Idle Watchdog (`packages/cli/src/ui/hooks/useGoalActive.ts`)
To prevent the agent from getting stuck in infinite loops, silent errors, or idling without calling tools, the system runs an active watchdog:
- Monitor turns and idle durations.
- If the AI pauses or stalls without progress, the watchdog injects a system alert: `[Easy Code ⏰ GOAL WATCHDOG]` to prompt the AI to analyze its obstacle, change its route, or declare progress.
- VS Code plugin counterpart: `vscode-webview` includes a matching webview-side idle watchdog to synchronize this protection across IDEs.

### 3. Goal Achieved & Auto-Clear
- **Goal Completion**: The agent must call the `goal_achieved` tool with a rigorous, objective explanation of how each completion criterion was met.
- **Contract Dissolution**:
  - Automatically triggers `/goal clear` logic.
  - Clears `activeGoalContext` inside the Gemini client memory so subsequent context compressions do not re-inject stale goal prompts.
  - Injects a system prompt reminding the AI that its contract is now dissolved and it is free to halt.

## Feishu Integration Details & Routing

When executing `/goal` in the Feishu Channel, special routing is applied to maintain the session lifecycle:
- **Interactive Form Card**: When a user inputs `/goal` or `/goal new` in a Feishu chat, the command intercepts the request and issues an interactive card form (`askGoalFormViaCard`) to the user.
- **Deferred Launch**: Setting YOLO mode and activating the goal watchdog must be deferred until the session-specific, isolated config/client is fully initialized. Initiating them on the shared CLI config will trigger the watchdog on the main TUI hall, causing execution leak.
- **Synchronized Message Queue**: Once the form is submitted, the compiled goal prompt (assembled via `buildGoalPrompt`) is written back to both `messageText` and `msg.text` to guarantee it safely reaches the isolated queue consumer.

## Sub-commands Reference

- `/goal` (or `/goal new`): Opens the interactive React-Ink step-by-step form to bootstrap a new goal contract.
- `/goal clear`: Abruptly terminates the goal contract and releases the AI from constraints.

## Related Pages
- [[tools-system]]
- [[cli-module]]
- [[core-module]]
