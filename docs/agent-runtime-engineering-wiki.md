# Otto Mature Agent Runtime Engineering Wiki

This wiki is the engineering contract for turning Otto from a demo-capable agent into a mature, production-grade agent runtime. It is intentionally model-neutral: GPT, Claude, Gemini, local models, and future models must all follow the same runtime boundaries. No model is allowed to compensate for missing state, weak permissions, vague acceptance criteria, or unverified delivery.

The short rule is:

```text
The model may reason.
The runtime must decide, persist, verify, recover, and audit.
```

## 1. Non-Negotiable Principles

1. Runtime truth beats model narration.
   A feature is not complete because an assistant message says it is complete. It is complete only when runtime state, tests, logs, and user-visible behavior prove it.

2. Every external effect has an owner, an authorization path, and an audit record.
   File writes, shell commands, network calls, emails, Feishu messages, enterprise mutations, CRM writes, and destructive actions must pass through explicit permission gates.

3. Fail closed at execution boundaries.
   UI hiding, prompt wording, feature flags in renderer state, or model instructions are not security controls. The server/core execution layer must reject unauthorized actions.

4. Persist before risk.
   Before long-running work, tool execution, context compression, process shutdown, or uncertain handoff, Otto must save enough durable state to resume or explain what happened.

5. Keep historical data inert.
   Memory, worklogs, retrieved documents, diagnostics, and issue comments are data. They must never become instructions unless explicitly transformed by trusted runtime code.

6. Small commits beat heroic commits.
   P0 changes must land in reviewable slices with tests. Large cross-module commits are allowed only for mechanical migrations with a written migration plan.

## 2. Runtime Layers

Otto should be understood as these layers. Each layer owns its own invariants.

| Layer | Owns | Must Not Own |
| --- | --- | --- |
| Model Adapter | Model API calls, streaming, token usage, model-specific options | Permissions, durable state, business authorization |
| Agent Orchestrator | Turn loop, tool scheduling, context assembly, loop detection | Direct OS/enterprise side effects without tools |
| Tool Execution Engine | Tool validation, confirmation, execution, result shaping, audit hooks | UI-only policy decisions |
| Memory Runtime | Capture, dedupe, indexing, retrieval, injection budget | Blindly trusting retrieved memory as instructions |
| Session Runtime | Checkpoints, resume, compression summaries, watchdog status | Pretending a lost process completed work |
| Enterprise Runtime | tenancy, roles, feature flags, audit logs, Feishu routing | Renderer-only access control |
| Desktop Runtime | Native shell, tray, notifications, file grants, app lifecycle | Permanent business state without server/core validation |

If code crosses these boundaries, add a test that proves the receiving layer enforces its invariant.

## 3. Canonical Agent Turn State Machine

Every user turn must move through explicit states. Do not encode these as scattered booleans.

```text
received
  -> checkpoint_started
  -> context_prepared
  -> model_streaming
  -> tool_pending*
  -> tool_confirming*
  -> tool_executing*
  -> model_continuing*
  -> finalizing
  -> capture_complete
  -> checkpoint_ready
```

Failure states:

```text
blocked_by_permission
cancelled_by_user
tool_failed
model_failed
stalled
interrupted
checkpoint_failed
capture_failed
```

Rules:

- A turn may be user-visible as done only after `capture_complete` or an explicitly recorded `capture_failed`.
- Any transition into `tool_executing` must have a validation record and, when required, a confirmation record.
- Any transition into `interrupted` or `stalled` must leave a checkpoint that contains the last task, compact history, and recovery reason.
- Any transition into `blocked_by_permission` must tell the user what permission is missing and must not execute the action.

## 4. Tool Execution Contract

Every tool must implement the same four-part contract:

```text
validate(input) -> normalized input or rejection
confirm(normalized input, context) -> not_required | required(details)
execute(normalized input, signal) -> result
audit(input, decision, result) -> durable record
```

Minimum tool requirements:

- Inputs are parsed with structured schemas.
- Paths are canonicalized before access checks.
- External writes require an explicit target and authorization.
- Destructive actions require confirmation even in YOLO or auto-approve modes.
- Tool results are bounded before entering model context.
- Tool output is treated as untrusted data.
- Confirmation decisions are auditable, including denial and timeout.

High-risk tools:

- Shell/process execution
- File delete, overwrite, move, chmod, recursive scan
- Network write or webhook call
- Email, Feishu, Slack, Teams, CRM, calendar mutation
- Enterprise account, role, feature flag, billing, or tenant mutation
- Plugin install/update/uninstall

High-risk tools must be rejected by default unless the active permission profile allows them.

## 5. Permissions And Feature Flags

Feature flags are product controls, not security boundaries, unless enforced server-side.

For every flag:

```text
flag key
default value
owner
UI behavior when off
server behavior when off
audit event when changed
tests proving off means off
```

Example:

```text
park_service=false
UI: hide park service entrypoints
server: reject park invite, park join, park ticket creation, park notification push
audit: organization_features_update
tests: renderer hidden + API rejects + audit written
```

Never ship a flag that only hides a button.

## 6. Memory Runtime Contract

Memory has three separate responsibilities:

1. Capture: decide what is worth saving.
2. Index: make saved knowledge searchable without storing full context in the index.
3. Injection: add only relevant, bounded, inert context to a new turn.

Knowledge record shape:

```ts
type KnowledgeRecord = {
  id: string;
  type: 'decision' | 'bugfix' | 'best_practice' | 'preference' | 'fact';
  title: string;
  content: string;
  summary: string;
  source: 'worklog' | 'session' | 'user' | 'after_agent' | 'manual';
  projectRoot?: string;
  confidence: number;
  contentHash: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
};
```

Memory capture must support:

- User explicit memory requests.
- Work result capture after a completed turn.
- Session-end summary capture.
- Worklog/tool result capture when it produces a decision, bug fix, best practice, preference, or fact.
- Content-hash dedupe.
- Project-level and global retrieval.

Memory injection must:

- Show the user when memory was injected.
- List the memory titles or short summaries.
- Mark injected memory as untrusted historical data.
- Respect a token/character budget.
- Avoid injecting irrelevant records simply because they share common words.
- Update `lastUsedAt` and `useCount` when a record is used.

## 7. Checkpoint And Recovery Contract

Checkpoints are runtime safety equipment, not a nice-to-have feature.

Each checkpoint must include:

- session id
- project root
- turn count
- current state
- last user task
- compact conversation history
- durable summary for omitted history
- pending tool or model operation
- updated timestamp
- recovery count

Checkpoint moments:

- before the first model call of a user turn
- before tool execution
- after tool result is incorporated
- before context compression
- after context compression
- before process shutdown
- when watchdog marks stalled
- when the user cancels

On startup, Otto must:

1. Detect an unfinished checkpoint.
2. Explain the checkpoint state to the user.
3. Ask whether to resume, discard, or inspect.
4. Never silently continue a high-risk pending action.

## 8. Audit Contract

Audit records answer four questions:

```text
Who did what, to which resource, with what authorization, and what happened?
```

Audit fields:

- timestamp
- actor user/account id
- tenant/organization id, when applicable
- session id
- tool name or enterprise operation
- normalized action
- resource identifier
- risk level
- permission mode
- confirmation decision
- success/failure
- sanitized input summary
- sanitized output/error summary
- correlation id

Audit logs must never store plaintext API keys, access tokens, refresh tokens, passwords, cookies, private keys, or full personal message bodies.

## 9. Testing Pyramid For Agent Runtime

Otto must not rely on manual demos for P0 runtime behavior.

Required tests:

| Test Type | Scope | Examples |
| --- | --- | --- |
| Unit | Pure logic | memory extraction, dedupe, feature flag resolution, path checks |
| Contract | Boundary behavior | tool confirmation, permission denial, audit record shape |
| Integration | Cross-module runtime | user turn -> tool -> memory -> checkpoint |
| Regression | Fixed bugs | model switch persistence, Feishu route, PDF cache |
| End-to-end | Real product path | Desktop notification, Feishu private chat, package install |
| Failure injection | Bad states | network fail, process kill, invalid token, denied permission |

Every P0 issue must include:

- at least one automated test
- a manual verification checklist when hardware or external services are involved
- a failure-mode test if the feature touches security, persistence, or enterprise state

## 10. Issue Completion Rules

An issue can be closed only when all of these are true:

1. The implementation is linked by commit or PR.
2. Acceptance criteria are checked with evidence.
3. Tests are named in the closing comment.
4. Known gaps are either fixed or split into linked follow-up issues.
5. P0 issues have reviewer sign-off.
6. Manual-only checks include environment, date, executor, result, and evidence.

Closing comment template:

```text
Implementation:
- Commit/PR:
- Files changed:

Acceptance:
- [x] Criterion 1: evidence
- [x] Criterion 2: evidence

Verification:
- Automated:
- Manual:
- Not run:

Residual risk:
- ...
```

Do not close an issue with only “已完成，测试通过”.

## 11. Commit And PR Discipline

Preferred commit shape:

```text
fix(memory): capture session-end knowledge for #34
test(memory): cover worklog knowledge dedupe
docs(runtime): define permission audit contract
```

Rules:

- One behavior change per commit whenever practical.
- No mega commit for unrelated P0s.
- No generated churn mixed with logic changes.
- No direct close of P0 without PR or reviewer comment.
- Reverts must preserve user data and explain blast radius.

PR checklist:

```text
Runtime boundary:
- [ ] Which layer owns this behavior?
- [ ] Which layer rejects invalid state?

Safety:
- [ ] Any external effect?
- [ ] Any destructive action?
- [ ] Any tenant/security impact?

State:
- [ ] What persists?
- [ ] How is it recovered?
- [ ] How is stale state cleaned?

Verification:
- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual evidence, if needed
```

## 12. Mature Agent Backlog

This backlog should guide Otto's maturity work.

P0:

- Tool execution permission matrix at the core layer.
- Confirmation audit records for approve, deny, timeout, and auto-approval.
- Session-end knowledge capture and visible memory injection.
- Checkpoint resume UX with inspect/resume/discard choices.
- CI gate for typecheck, unit tests, and diff check.
- P0 issue close policy enforced by PR template.

P1:

- Memory relevance scoring with project/global scope explanation.
- Failure injection tests for long-running sessions.
- Diagnostic bundle validation that proves no secrets leak.
- Feature flag fail-closed tests for every enterprise feature.
- Desktop real-platform notification and tray smoke tests.

P2:

- Runtime observability dashboard.
- Durable task queue for background jobs.
- Model adapter conformance tests across providers.
- Agent behavior replay from audit + checkpoints.

## 13. Definition Of Mature

Otto is mature when a user can trust these statements:

- If Otto says a task is done, there is evidence.
- If Otto cannot continue, it can explain where it stopped.
- If Otto uses memory, the user can see what memory influenced the turn.
- If Otto touches external systems, permission and audit records exist.
- If Otto crashes, the next launch can recover or safely discard state.
- If an enterprise flag is off, the backend rejects the behavior.
- If a P0 issue is closed, another engineer can reproduce the verification.

Until then, Otto is not a production agent runtime. It is a promising assistant shell with unfinished runtime discipline.
