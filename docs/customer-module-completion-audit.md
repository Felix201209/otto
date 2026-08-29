# Customer module v1 completion audit

This file maps the v1 product requirements to executable evidence. It is intentionally specific so later agents do not treat a passing narrow unit test as proof of the whole feature.

| Requirement | Implementation evidence | Verification evidence |
| --- | --- | --- |
| Signed manifest and deterministic package | `packages/core/src/customer-modules/customerModuleManifest.ts`, `customerModulePackage.ts`, `customerModuleSignature.ts` | manifest, package, signature test suites |
| No traversal, symlinks, undeclared files, dynamic imports, unknown ABI | manifest archive validation and WASM scanner | manifest and scanner negative cases |
| WASM/WASI isolation and resource limits | bounded Worker runner; 64 MiB declared linear-memory ceiling; four-run, timeout, output, progress and Host-call ceilings; safe WASI Preview1 subset | scanner and runner suites, including socket rejection, infinite loop, cancellation, crash and concurrency |
| Versioned Host ABI with permission, policy and audit boundary | `customerModuleHost.ts` and Desktop host adapter | undeclared capability, idempotency, failed-call redaction, 429, 5xx and timeout tests |
| Foreground model invocation | tool-free temporary Otto chat with MCP, tools and ambient environment disabled | `customerModuleModelAdapter.test.ts`; provider and Token attribution asserted; pre-call cancellation asserted |
| Recoverable external writes | per-module HTTP/file operation ledger bound to operation fingerprint and idempotency key | repeated-operation recovery tests; install receipt offline/reconnect test |
| Registry integrity and lifecycle | signed/hash/compatibility validation before atomic switch; launch-time signature and WASM hash recheck; disable/uninstall/export/clear separation | installer suite, including tamper, missing trust key, suspension, disk-full atomicity and receipt recovery |
| Publishing and review | SQLite versions/artifacts/receipts, isolated scan, human review, platform signing, suspension/withdrawal and public list | marketplace, repository, submission and route suites |
| Tenant and commercial authorization | member/platform route split plus `skill_market` commercial gate | enterprise and commercial route-policy suites |
| Desktop authoring and use | six-step authoring, sandbox trace, declarative input, required-field validation, market details, permission diff, install/run/cancel and lifecycle controls | renderer authoring/catalog/marketplace tests, Desktop typecheck and production build |
| Safe rollout and zero idle cost | internal/invite/public/disabled publisher mode; no customer-module background scheduler; foreground-only model adapter | 24/72-hour idle-safety simulation and settings regression tests |
| Database and release compatibility | enterprise schema 23 and integration capability ledger | enterprise DB migration suite and server-integration baseline suite |

The supported WASI surface does not include sockets, path operations, directory preopens, environment values, subprocesses, or commands. A future expansion must add new scanner allow-list entries, bounded host implementations, and negative tests together.
