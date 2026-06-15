---
type: entity
date: 2026-04-09
tags: [class, core, tool-execution, state-machine]
sources: [raw/04-tools-system.md, raw/02-core-module.md]
---

# ToolExecutionEngine

> State machine managing tool execution lifecycle.

## Overview

`ToolExecutionEngine` 管理工具调用的完整状态机，从验证、调度、确认到执行。与 `coreToolScheduler` 配合桥接 UI 层。

## State Machine

```
FunctionCall → validating → scheduled → shouldConfirmExecute()
  → awaiting_approval or executing
  → Cancel → cancelled / Proceed → executing / Modify → editor → executing
  → execute() → success or error
```

## Location

`packages/core/src/core/toolExecutionEngine.ts`

## Related

- [[ToolRegistry]] — provides tool instances
- [[BaseTool]] — tools being executed
- [[hooks-system]] — BeforeTool/AfterTool events wrap execution
- [[tools-system]]
