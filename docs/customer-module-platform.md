# Customer module platform v1

Customer modules are reviewed WASM/WASI tool packages owned by `tool_skill_platform`, not runtime-kernel extensions.

## Rollout and signing

- `OTTO_CUSTOMER_MODULE_MARKET_MODE=internal|invite|public|disabled` controls publisher access and defaults to `internal`.
- Internal mode permits organization admins and IDs listed in `OTTO_CUSTOMER_MODULE_PUBLISHER_IDS`; invite mode permits only that list.
- Approval requires `OTTO_CUSTOMER_MODULE_SIGNING_PRIVATE_KEY` and `OTTO_CUSTOMER_MODULE_SIGNING_KEY_ID`.
- Desktop installation trusts only Ed25519 public keys configured in `OTTO_CUSTOMER_MODULE_TRUSTED_PUBLIC_KEYS` as a JSON key-ID to PEM map.
- Suspended or withdrawn signed versions stop new installation. Desktop refresh marks an installed copy risky and disables execution.

## Safe defaults

- Installation and every version change require confirmation of the complete permission set; the UI calls out newly added permissions.
- Background authorization always installs off. A publisher may declare it, but the user must enable it separately; execution still requires Otto's registered background-task scheduler and cannot be started by raw module timers.
- Model, HTTP, file, and storage calls traverse the Host ABI permission broker and emit origin/provider/token/retry/cost/commit audit fields.
- Foreground model calls use a tool-free temporary Otto model session with no MCP discovery or ambient environment context. Cancellation propagates to the provider request; unavailable pricing is displayed as unknown rather than zero.
- HTTP is HTTPS-only, exact-host allow-listed, redirect-disabled, time-bounded, and size-bounded. HTTP and file writes must carry an idempotency key.
- WASI Preview1 support is intentionally limited to empty args/environment, stdout/stderr, bounded random bytes, fd metadata, and process exit. Sockets, directory preopens, path operations, commands, and environment access are rejected during scanning.
- Uninstall removes executable artifacts and authorization while preserving scoped data. Data clearing is a separate destructive confirmation.

## Review pipeline

Upload is decoded in an isolated request path, then archive paths, declared files, hashes, WASM imports/exports, and a bounded no-capability sandbox run are checked before artifacts are persisted. A platform reviewer must approve the scanned version; only then is its manifest signed and exposed through the public package endpoint.
