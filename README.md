# Otto

Otto is an agent runtime that is being moved toward a lightweight native-core architecture.

Current `1.9.2` releases still enter through the Node/TypeScript CLI bundle (`bundle/otto.js`). The Rust crate under `otto-native/` is the native hot-path core and is now treated as the preferred runtime for the three areas that most affect low-resource multi-agent performance:

- `agent_pool`: sub-agent concurrency, memory accounting, idle cleanup, and pending-log buffering.
- `session_store`: session persistence, metadata listing, cache-aware reads, and bounded history.
- `tokenizer`: local token counting, truncation, and tokenizer capability discovery.

The product goal is deliberately small: keep the kernel compact, keep external components independent, and make GUI or distribution-specific changes possible without rewriting the kernel.

## Native core policy

Runtime selection is controlled by `OTTO_NATIVE_CORE`:

- `auto` (default): use the Rust native core when an `otto-native` binary is present; otherwise fall back to the TypeScript implementation.
- `required`: require the Rust binary and fail fast if it is missing.
- `off`: disable the Rust bridge and use the TypeScript fallback.

Set `OTTO_NATIVE_CORE_BINARY` to point at a specific signed native binary.

Enterprise distributions should use `OTTO_NATIVE_CORE=required` and a signed native artifact manifest. The manifest budget currently requires the release distribution to stay at or below 10MB.

## Build the Rust native core

```bash
cd otto-native
cargo build --release
```

Expected binary locations include:

- `otto-native/bin/otto-native`
- `otto-native/bin/otto-native.exe`
- `otto-native/target/release/otto-native`
- `otto-native/target/release/otto-native.exe`

## Verify the repository

```bash
npm run doctor
npm run test --workspace packages/core
npm run typecheck --workspace packages/core
```

For release-size verification, place compiled artifacts in `bundle/` or `otto-native/bin/`, or set `OTTO_DOCTOR_RELEASE_ARTIFACT_DIR` to the release artifact directory before running `npm run doctor`.

## Architecture notes

- The TypeScript layer owns product orchestration, policies, adapters, and user-facing experience.
- The Rust native core owns the bounded hot paths that must stay fast on low-memory machines.
- Optional tools, enterprise connectors, and GUI variants should remain external components rather than kernel code.
- Old source-heavy implementations should only remain as safe fallbacks while their Rust replacement is incomplete.

See:

- `packages/core/src/native/nativeHotPaths.ts`
- `packages/core/src/native/nativeCoreBridge.ts`
- `packages/core/src/kernel/kernelDistributionManifest.ts`
- `docs/enterprise-component-architecture.md`
