---
type: entity
date: 2026-04-09
tags: [class, core, tool, base-class, abstract]
sources: [raw/04-tools-system.md, raw/02-core-module.md]
---

# BaseTool

> Abstract base class implementing the Tool interface for all built-in tools.

## Overview

`BaseTool<TParams, TResult>` 是所有内置工具的抽象基类，定义了工具的标准生命周期：参数验证 → 确认检查 → 执行 → 返回结果。

## Tool Lifecycle

1. `validateToolParams()` — SchemaValidator + custom checks
2. `getDescription()` — pre-execution UI description
3. `shouldConfirmExecute()` — returns false (auto) or confirmation details
4. `execute()` — core logic → `ToolResult`

## ToolResult Structure

```typescript
{
  llmContent: PartListUnion;
  returnDisplay: ToolResultDisplay;
  summary?: string;
  backgroundTaskId?: string;
  visualDisplay?: VisualDisplay;
}
```

## Pattern

**Abstract Base Class** / **Template Method**

## Location

`packages/core/src/tools/tools.ts`

## Related

- [[ToolRegistry]] — registers BaseTool instances
- [[DiscoveredMCPTool]] — extends BaseTool for MCP
- [[ToolExecutionEngine]] — orchestrates execution
- [[tools-system]]
