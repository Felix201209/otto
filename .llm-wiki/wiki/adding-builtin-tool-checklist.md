---
type: guide
date: 2026-05-22
tags: [tools, checklist, conventions, debugging, tool-registration]
sources: [packages/core/src/tools/local-time.ts, packages/core/src/tools/read-lints.ts, packages/core/src/tools/web-search.ts, packages/core/src/tools/ask-user-question.ts, packages/core/src/tools/tools.ts, packages/core/src/config/config.ts]
---

# Adding a Built-in Tool — Checklist & Pitfalls

> Battle-tested checklist for adding a new built-in tool to `packages/core/src/tools/`.
> Derived from a real bug where `local_time` was registered correctly but
> calls were silently dropped (`finishReason=FUNCTION_CALL, functionCalls=0`)
> due to schema/description format inconsistencies with other tools.

## TL;DR

When a new tool "registers fine but never actually executes", the bug is
almost always **schema/description format drift** from the other tools, not a
registration issue. Conform strictly to the patterns in `read-lints.ts` and
`web-search.ts` (the canonical simple tools).

## Mandatory Checklist

### 1. File Location & Class Skeleton

- File: `packages/core/src/tools/<kebab-name>.ts`
- Extend [[BaseTool]] with `<Params, ToolResult>` generics
- Static `Name`: snake_case, matches the tool's public API name
- Static `Name` value === schema function name === argument to `registerCoreTool`

### 2. Description String — Pitfall Zone

**❌ Don't:**

```ts
const DESC = `
Returns the current wall-clock local time...
- iso:    ISO 8601 timestamp (UTC) — best for diff math.
`;
```

Why this breaks:

- **Leading `\n`** — schema `description` field starts with whitespace; some
  upstream proxies/converters strip whitespace and leave a malformed entry.
- **Em-dash `—` and other non-ASCII glyphs** — round-trip safely through most
  JSON paths but have caused tool-call drops in older Vertex/proxy chains.
- **Quoted ISO timestamps inside description** — embedded `"2026-..."` strings
  can confuse naive JSON-string escapers in adapter layers.

**✅ Do:**

```ts
const DESC =
  'Returns the current wall-clock local time of the machine running Easy Code.\n\n' +
  'Use this tool to:\n' +
  '- Determine the current real-world time.\n' +
  '- Record a "start time" at the beginning of a long task.';
```

- First character must be a real character, never `\n` or whitespace.
- Prefer ASCII punctuation: `-`, `(`, `)`, `:`. No em-dashes, smart quotes, etc.
- Keep description tight — the model sees this for tool selection.

### 3. Constructor Signature — Don't Over-specify Booleans

**❌ Don't pass all 4 boolean flags explicitly:**

```ts
super(
  Name, 'Display', DESC, Icon.Info, schema,
  /* isOutputMarkdown */ true,
  /* forceMarkdown */ false,
  /* canUpdateOutput */ false,
  /* allowSubAgentUse */ true,
);
```

**✅ Pass only the booleans that differ from the defaults:**

```ts
super(Name, 'Display', DESC, Icon.Info, schema);
// defaults: isOutputMarkdown=true, forceMarkdown=false,
// canUpdateOutput=false, allowSubAgentUse=true
```

See [[BaseTool]] for the default values. Match the style of `web-search.ts`.

Override `allowSubAgentUse=false` only when the tool requires a TTY user
(e.g. `ask_user_question`) or could cause infinite nesting (e.g. `task`).

### 4. `displayName` — Single PascalCase Word

- ✅ `'LocalTime'`, `'ReadLints'`, `'AskUserQuestion'`, `'WebSearch'`
- ❌ `'Local Time'` (space), `'local_time'` (snake), `'localTime'` (camel)

### 5. Schema Conventions

```ts
{
  type: Type.OBJECT,
  properties: {
    paramName: {
      type: Type.STRING,           // NOT 'string' lowercase
      description: '...',           // sentence-style, ASCII only
    },
  },
  required: [],                     // empty array OK; do NOT omit the field
}
```

- Always use `Type.OBJECT/STRING/ARRAY/...` enum from `@google/genai`,
  never raw string literals.
- Always include `required: []` even if empty — many adapter layers expect
  the field to exist.
- For optional params, include them in `properties` and leave `required` empty.

### 6. `validateToolParams` — Always Run SchemaValidator First

```ts
override validateToolParams(params: Params): string | null {
  const errors = SchemaValidator.validate(
    this.schema.parameters, params, MyTool.Name,
  );
  if (errors) return errors;

  // …business validation after schema validation…
  return null;
}
```

Skipping `SchemaValidator.validate` is the single most common drift from
canonical tool format. Some adapters rely on the structured error message
shape `'Error: Invalid parameters provided. Reason: ...'`.

### 7. `execute()` Error Return Format

Match the standard envelope used by `web-search.ts`, `read-lints.ts`:

```ts
const validationError = this.validateToolParams(params);
if (validationError) {
  return {
    llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
    returnDisplay: `Parameter validation failed: ${validationError}`,
  };
}
```

### 8. `returnDisplay` — Plain Text by Default

Avoid emoji in `returnDisplay` for tools that may be invoked by sub-agents
or in non-interactive contexts. Stick to plain text + markdown structure
like `read-lints` does. Emoji-heavy display strings have caused issues in
older serializers.

If the tool wants markdown rendering, set `isOutputMarkdown=true` (default)
and structure with `## Headings`, `**bold**`, etc.

### 9. Provide a `summary` Field

```ts
return {
  llmContent: ...,
  returnDisplay: ...,
  summary: 'Short one-liner for UI history collapse',
};
```

Without `summary`, the UI history view falls back to the full output, which
clutters long sessions.

### 10. Registration in `config.ts`

```ts
import { MyTool } from '../tools/my-tool.js';
// …
registerCoreTool(MyTool, this);
```

- Add `import` near the other tool imports
- Add the `registerCoreTool(MyTool, this)` call in `createToolRegistry()`
- For tools that should be excluded in VSCode plugin mode, gate with
  `if (!this.getVsCodePluginMode()) { ... }` like `TaskTool` does

### 11. Export from `core/src/index.ts`

```ts
export * from './tools/my-tool.js';
```

…or add `MyTool: () => MyTool` to the named exports map. Without this,
external callers and bundle introspection can't find the class.

### 12. Rebuild the Bundle

After changes to `packages/core/src/tools/`:

```bash
npm run build
```

This is mandatory — `bundle/easycode.js` is what the CLI actually runs.
Source-only changes won't take effect until the bundle is rebuilt.

To verify the tool ended up in the bundle:

```bash
findstr /C:"MyTool:()=>" bundle\easycode.js
```

(Linux/macOS: `grep -o 'MyTool:()=>' bundle/easycode.js`)

## Reference Tools by Complexity

| Reference | Use as template when adding… |
|-----------|------------------------------|
| `web-search.ts` | A simple tool with one required string param + one async API call |
| `read-lints.ts` | A tool with optional array param, no confirmation, structured output |
| `local-time.ts` | A pure-function tool with optional param, no external I/O |
| `ask-user-question.ts` | A tool that requires user confirmation/dialog |

## Debugging "Tool Registered but Never Executes"

Symptom in logs:

```
[STOP-DEBUG] Turn.run(): finishReason=FUNCTION_CALL, functionCalls=0, hasText=false
[STOP-DEBUG] sendMessageStream: no pending tool calls, checking nextSpeaker...
[STOP-DEBUG] sendMessageStream: nextSpeaker is NOT model, ENDING conversation turn
```

Translation: the model returned a function-call signal, but the adapter
parsed `0` function calls out of the response, so [[Turn]] ended the turn
without scheduling anything.

Diagnosis order:

1. **Confirm registration** — `findstr "MyTool, this" bundle/easycode.js`
   (won't match exact text after minify; check `grep MyToolName bundle/...`).
2. **Re-check description string** for leading whitespace, em-dashes,
   embedded quotes, control characters.
3. **Re-check schema** — types must use `Type.X` enum, `required` field
   present, no `additionalProperties: true` typos.
4. **Compare line-by-line with `read-lints.ts`** — diff helps spot drift.
5. **Rebuild bundle and retry.**

In the `local_time` case, fixing #2 (leading `\n`, em-dash, emoji in
returnDisplay) plus #6 (missing `SchemaValidator.validate`) plus #3 (over-
specified constructor booleans) made the tool start working immediately.

## Related

- [[BaseTool]] — abstract base class and default values
- [[ToolRegistry]] — where tools are registered
- [[ToolExecutionEngine]] — execution state machine
- [[Turn]] — where missing tool calls become silent drops
- [[tools-system]] — high-level tools system overview
