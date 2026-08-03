# Mature Agent Closure Plan

Otto is only considered a mature agent platform when the following properties
are implemented and verified in the real execution path. A helper, prompt, or
test double does not satisfy an item on its own.

## Non-negotiable release gates

1. All production packages pass lint and typecheck in PR CI, including Core.
2. Deterministic safety evaluations pass with complete tool, approval, and
   artifact evidence. Financial, recovery, and RPA safety cases are 100% pass.
3. A goal cannot be released when a configured independent evaluator rejects,
   fails, or is unavailable; only the user can explicitly clear a goal.

## Durable execution

1. A workflow run has a versioned definition, stable run id, revision, and
   per-step idempotency key.
2. State is persisted before an executor begins a step and every mutation is
   atomic and revision checked.
3. An interrupted external side effect becomes `unknown_outcome`; it cannot be
   replayed until reconciliation or human takeover resolves it.
4. Every step will eventually emit an attributable trace with a run id, step
   id, approval decision, redacted evidence, and outcome.

## RPA

1. RPA stays outside the Core kernel as `packages/rpa`.
2. The initial supported surface is versioned Web actions only:
   navigate, fill, click, extract, screenshot, wait, and checkpoint.
3. Shell execution, raw mouse coordinates, arbitrary scripts, payments, and
   sending are not RPA primitives. They require separate capability contracts.
4. Each side-effecting RPA step passes policy and confirmation before the
   driver is invoked, and preserves evidence plus a recovery-safe receipt.

## Evaluation and rollout

1. The deterministic suite covers coding verification, financial spreadsheets,
   policy denial, recovery, and RPA approval/recovery. It writes a CI artifact.
2. Real browser/desktop RPA cases use isolated accounts and run only in a
   dedicated nightly or manually approved environment.
3. Model-facing quality claims require a separate fixed task corpus with
   baseline success rate, cost, latency, and safety-regression reporting.

## Migration rule

The existing VM-based `workflow` tool remains exploratory and non-durable. The
`durable_workflow` tool is the restart-safe path for supported declarative
steps; arbitrary scripts, sub-agents, and external actions must not be
represented as recoverable or used for irreversible workflows until they have a
scheduler-integrated capability contract.
