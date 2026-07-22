# Otto Adapters

Optional, swappable integrations that live **outside** `packages/core/`.

## Why Adapters?

Core defines **interfaces** — adapters provide **implementations**.
This keeps `packages/core/` lightweight, free of optional dependencies,
and easy to test. Any external service (Mem0, Redis, PostgreSQL, S3,
WebSocket, etc.) is an adapter that implements a core interface.

## The Golden Rule

> **Core never imports from adapters. Adapters import from core.**

```
                    ┌──────────────────┐
                    │  packages/core/  │
                    │  (interfaces)    │
                    └────────┬─────────┘
                             │ implements
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
     │ mem0/       │ │ redis/      │ │ postgres/   │
     │ (Mem0 API)  │ │ (Redis KV)  │ │ (SQL store) │
     └─────────────┘ └─────────────┘ └─────────────┘
```

## Known Interfaces

| Interface | Defined In | What It Does |
|---|---|---|
| `MemoryProvider` | `packages/core/src/memory/memoryProvider.ts` | Load/save memory by scope (global/project/session) |
| *(more interfaces will be added as we extract adapters)* | | |

## Creating a New Adapter

### Step 1: Identify the interface

Find (or create) the interface in `packages/core/src/` that your adapter
implements. The interface should be:

- Named clearly (e.g., `MemoryProvider`, `CacheStore`, `FileStore`)
- Minimal: only the methods the adapter needs to satisfy
- Framework-agnostic: no React, Electron, or platform-specific types

### Step 2: Create the adapter package

```bash
mkdir -p packages/adapters/<name>/
touch packages/adapters/<name>/index.ts
touch packages/adapters/<name>/package.json
```

### Step 3: Implement the interface

```typescript
// packages/adapters/<name>/index.ts

import { MemoryProvider, MemoryScope } from 'otto-core';

export class MyCustomAdapter implements MemoryProvider {
  readonly name = 'my-custom';

  async load(scope: MemoryScope): Promise<string> { /* ... */ }
  async save(scope: MemoryScope, fact: string): Promise<void> { /* ... */ }
}
```

### Step 4: Add package.json

```json
{
  "name": "otto-adapter-my-custom",
  "version": "1.0.0",
  "private": true,
  "description": "Otto adapter: my custom memory backend",
  "type": "module",
  "main": "index.ts",
  "peerDependencies": {
    "otto-core": "*"
  }
}
```

Set `"private": true` unless the adapter is published to npm.

### Step 5: Add backward-compat re-export in core

If the adapter was previously in `packages/core/src/`, add a re-export
in `packages/core/src/index.ts` so existing consumers don't break:

```typescript
// packages/core/src/index.ts
export * from '../../adapters/<name>/index.js';
```

### Step 6: Update the kernel boundary test

Add the adapter directory to `packages/core/src/core/kernelBoundary.test.ts`
to enforce import direction (core → adapters ❌, adapters → core ✅).

### Step 7: Test

```bash
npx tsc -p packages/core/tsconfig.json --noEmit
npx vitest run packages/core/src/core/kernelBoundary.test.ts
```

## Adapter Checklist

- [ ] Implements a core interface (imported from `packages/core/` or `otto-core`)
- [ ] Lives under `packages/adapters/<name>/`
- [ ] Has a `package.json` with name, version, `"private": true`
- [ ] Has an `index.ts` that exports the adapter class
- [ ] Does NOT cause core to import from `packages/adapters/`
- [ ] Backward-compat re-export added to `packages/core/src/index.ts` (if moved)
- [ ] Kernel boundary test updated
- [ ] TypeScript compiles cleanly (`npx tsc --noEmit`)
