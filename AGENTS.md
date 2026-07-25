# AGENTS.md

This file is the operating manual for AI agents working in the Otto repository.
Read it before changing code. Keep changes small, verified, and easy for the
next model to understand.

## Project identity

Otto is an AI coworker and coding agent with several surfaces:

- Runtime kernel and tools in `packages/core`
- Enterprise server in `packages/server`
- Desktop/Electron app in `packages/desktop`

The product goal is a mature agent runtime with a light kernel, strong module
boundaries, safe defaults, observable behavior, and replaceable outer
components.

## Golden rules

1. Prefer the smallest high-quality change that satisfies the issue.
2. Do not hide product behavior in logs only. If it affects the user, emit a
   typed event or user-visible status.
3. High-risk actions must go through confirmation, policy, and audit paths.
4. Do not put UI, provider-specific adapters, Feishu, desktop, or enterprise
   product logic into the runtime kernel unless the boundary document says so.
5. Preserve unrelated user changes. Never reset or overwrite work you did not
   create.
6. If you close an issue, leave a trace: commit hash, changed behavior, and
   verification result.

## Runtime kernel boundary

Use `docs/runtime-kernel-boundary.md` as the source of truth for what belongs in
the agent kernel.

Kernel code should own only lifecycle-critical concerns:

- turn lifecycle and stream events
- tool scheduling and execution state
- confirmation and policy gates
- audit event emission
- model routing contracts
- memory subsystem interface, not memory internals
- checkpoint and compression coordination

Everything else should stay outside the kernel behind an interface:

- desktop, CLI, Feishu, and web UI
- enterprise organization and park features
- provider-specific model adapters
- skills/plugins
- long-term memory storage implementation
- diagnostics, packaging, and release scripts

## Development discipline

For `packages/core`, `packages/server`, and `packages/desktop`, use test-driven development when the
change involves branches, state transitions, data conversion, or business
rules:

1. Add or update a focused regression test.
2. Implement the smallest fix.
3. Refactor only while the behavior is protected.

Acceptable exceptions:

- pure visual rendering polish
- terminal/TTY behavior that is impractical to mock
- thin third-party SDK pass-through
- one-off diagnostic scripts
- system-level IO where the test would be more brittle than the code

If you skip tests, say why in the commit or issue comment.

## Verification order

Start with cheap checks and only escalate when needed:

1. `npm run doctor`
2. `git diff --check`
3. focused unit test for the touched package
4. package `typecheck`
5. package or repo lint/build/test when the change is broad

If local dependencies are missing, do not pretend tests passed. Report the
doctor output and the exact command that could not run.

## Issue workflow

When converting a broad goal into work:

1. Create issues with clear acceptance criteria.
2. Keep each issue independently reviewable and reversible.
3. Solve the highest-value issue first.
4. Commit with a specific message.
5. Push to the working branch.
6. Comment on the issue with commit hash and verification.
7. Close only when the acceptance criteria are actually met.

## Safety rules

- Default to safe approval mode, not YOLO.
- Never store API keys or tokens in ordinary config files.
- Never log raw secrets. Use existing redaction helpers for audit, worklog, and
  diagnostics.
- Do not run destructive filesystem commands unless the issue explicitly
  requires it and the exact target has been verified.
- Permission denial and user cancellation are real outcomes; they should be
  visible and auditable.

## Cleanup rule

Dead code is harmful to agents because it creates false paths. If production
code no longer imports a helper, remove it or mark it deprecated with a pointer
to the replacement. Do not leave duplicate implementations for later models to
guess between.
