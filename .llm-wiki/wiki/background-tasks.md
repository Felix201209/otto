---
type: entity
date: 2026-05-30
tags: [core, services, background-tasks, process-management]
sources: [packages/core/src/services/backgroundTaskManager.ts, packages/cli/src/ui/hooks/useBackgroundTasks.ts, docs/BACKGROUND_TASKS_QUICK_REFERENCE.md]
---

# Background Task Management

The Background Task system allows Easy Code to run persistent, long-running shell commands (such as local servers or compilation watchers) in the background while keeping the primary terminal chat interactive and responsive.

## Why Background Tasks Exist

In traditional AI CLI architectures, running a command like `npm run dev` blocks the CLI thread indefinitely. Easy Code introduced background tasks to:
1. **Prevent Blocking**: Launch persistent server commands and allow the AI and user to continue chatting instantly.
2. **Resource Observability**: Track output streams, exit codes, and process IDs (PIDs) directly from the terminal UI.
3. **Control**: Empower the AI agent to list active background tasks and terminate them as needed without requiring the user to exit.

## Core Architecture

```
User/AI CMD → ShellTool.execute()
  → (if persistent/background)
  → BackgroundTaskManager.createTask()
  → spawn(subprocess)
  → Tracks stdout/stderr & updates state
```

## Key Classes & Methods

### `BackgroundTaskManager` (`packages/core/src/services/backgroundTaskManager.ts`)

A singleton EventEmitter coordinating all background sub-processes:

- `createTask(command, directory)`: Allocates a unique CRC32-based 7-char hash Task ID (e.g., `a1b2c3d`) and registers the task.
- `appendOutput(taskId, text)` / `appendStderr(...)`: Appends stream chunks to the task's buffer and emits events.
- `completeTask(taskId, options)` / `failTask(...)`: Finalizes the task with exit codes/signals/errors.
- `killTask(taskId)`: Forcefully terminates the process:
  - **Windows (win32)**: Spawns `taskkill /pid <PID> /f /t` to clean up child process trees.
  - **POSIX (Unix)**: Sends `SIGTERM` to the process.

## Tool & UI Integration

- **[[tools-system]] Integration**: The `run_shell_command` (`packages/core/src/tools/shell.ts`) tool supports:
  - `list_background_tasks` action: Lists all registered background processes, status, directory, PID, and start time in a neat markdown table.
  - `stop_background_task` action: Terminates any active task by its Task ID using `BackgroundTaskManager.killTask()`.
- **[[cli-module]] UI Integration**:
  - `useBackgroundTasks.ts`: A custom hook connecting React-Ink to the task manager.
  - `BackgroundTaskPanel.tsx` / `BackgroundTaskHint.tsx`: Displays live status notification overlays in the terminal when a background task completes or outputs new logs, and alerts the user without disrupting the prompt flow.

## Guidelines & Best Practices

1. **Cross-Platform Safety**: Always verify platform behavior. Windows requires `taskkill` for tree cleanup; POSIX relies on signal management.
2. **Safety Rails**: Avoid ending node processes or global processes that could kill the CLI host.
3. **Referencing**: Use `run_shell_command` actions to check if any required dev servers are already running before starting duplicate commands.

## Related Pages
- [[tools-system]]
- [[cli-module]]
- [[core-module]]
