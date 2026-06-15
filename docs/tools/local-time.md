# `local_time` Tool

A built-in tool that returns the current wall-clock local time of the machine running Otto.

## Purpose

Originally introduced for the [`/goal`](../cli/goal-command.md) command, where the model needs to
verify how long it has been working. Generally useful whenever the model needs to:

- Determine the real-world time.
- Record a "start time" at the beginning of a long task.
- Calculate elapsed task duration by comparing two readings.
- Timestamp checkpoints, todo updates, or logs.

The tool is **side-effect free**, **fast**, and **never requires user confirmation**, so the model
may call it as often as needed.

## Invocation

```jsonc
{
  "name": "local_time",
  "arguments": {
    // optional — IANA timezone, defaults to system local
    "timezone": "Asia/Shanghai"
  }
}
```

## Response Schema

`llmContent` is a JSON-encoded string with these fields:

| Field      | Type    | Description                                         |
|------------|---------|-----------------------------------------------------|
| `iso`      | string  | ISO 8601 UTC timestamp, e.g. `2026-05-22T10:42:13.000Z` |
| `unix_ms`  | number  | Milliseconds since the Unix epoch                   |
| `unix_s`   | number  | Seconds since the Unix epoch                        |
| `timezone` | string  | IANA timezone used for the `local` field            |
| `local`    | string  | Human-readable local time `YYYY-MM-DD HH:MM:SS`     |
| `weekday`  | string  | English weekday name, e.g. `Monday`                 |
| `warning`  | string? | Present only if a requested timezone was invalid; the tool fell back to the system timezone |

`returnDisplay` is a single short Markdown line for the UI, e.g.
`🕐 2026-05-22 18:42:13 (Asia/Shanghai, Friday)`.

## Calculating Elapsed Time

The recommended pattern (used by `/goal`):

1. Call `local_time` once at task start, save `unix_ms` as `T0`.
2. Later, call `local_time` again, take the new `unix_ms`.
3. `elapsed_seconds = (now.unix_ms - T0) / 1000`.

`unix_ms` is preferred for arithmetic because it avoids parsing ISO strings.

## Implementation

- File: `packages/core/src/tools/local-time.ts`
- Registered in: `packages/core/src/config/config.ts`
- Shared between CLI and VSCode UI plugin via `easycode-core` — adding it to core
  means both surfaces get the tool automatically with no extra wiring.

The tool delegates timezone formatting to `Intl.DateTimeFormat`, so it accepts any IANA
timezone supported by the underlying Node.js / V8 runtime.
