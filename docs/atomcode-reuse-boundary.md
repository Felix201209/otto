# AtomCode Reuse Boundary for Otto

> Status: adopted on 2026-07-31. This is a design boundary, not a migration
> plan. AtomCode is a reference implementation in another language; Otto keeps
> ownership of its TypeScript runtime and public protocol.

## Decision

Otto may reuse AtomCode's architectural principles, but it must not replace
Otto's runtime, state machine, tool protocol, storage, or UI with AtomCode
code. Any future work starts from an Otto-native seam and requires a focused
acceptance test.

| AtomCode principle | Otto-native owner | Decision |
| --- | --- | --- |
| One turn has one clear owner and lifecycle | `core/turn.ts`, `core/turnStateMachine.ts` | Reuse the principle; keep `TurnStateMachine` as the only lifecycle truth. |
| Runtime extension seams are explicit | `hooks/`, `core/toolSchedulerAdapter.ts` | Reuse the seam discipline; do not add AtomCode hook names or event types. |
| Checkpoint before unsafe progress and resume safely | `core/turnCheckpoint.ts`, `sessions/sessionCheckpointService.ts` | Reuse recovery semantics; preserve Otto replay classes and session format. |
| Tool calls have typed lifecycle and results | `core/toolExecutionEngine.ts`, `core/turn.ts` | Reuse the contract boundary; keep `EngineToolCall` and Otto events canonical. |
| File changes should be recoverable and ordered | `services/fileOperationQueue.ts`, `services/gitService.ts` | Reuse the safety objective; keep Otto's per-file queue and shadow Git history. |
| Results should not become unbounded prompt state | `core/ottoChat.ts`, compression services, tool response summaries | Reuse bounded-result thinking; do not introduce a generic external artifact store without a concrete consumer. |

## Reuse Rules

### May reuse as design input

- Single-owner runtime boundaries and directed dependencies.
- Small, typed hook seams instead of UI callbacks in the kernel.
- Checkpoint/recovery semantics that distinguish safe replay from irreversible
  side effects.
- Tool lifecycle conformance tests and protocol-level test matrices.
- File history that is isolated from the user's working Git repository.

### Must be rewritten in Otto terms

- TypeScript interfaces, event payloads, storage files, and serialization.
- Tool scheduling, confirmation, policy, audit, and replay classification.
- CLI, desktop, server, WebSocket, and Electron adapters.
- User-visible restore, diff, and work-log behavior.

### Do not touch for AtomCode alignment

- `TurnStateMachine` as the lifecycle source of truth.
- `ToolExecutionEngine` and `CentralPolicy` as the execution and approval
  boundary.
- `SceneManager` as model-routing owner.
- `MemorySubsystem` and `SessionMemoryInjector` as memory owners.
- Existing session, checkpoint, audit, and component-manifest formats.

## Gap Audit

| Capability | Current Otto status | Decision |
| --- | --- | --- |
| Turn lifecycle | Complete: deterministic state machine with terminal states. | No migration work. |
| Hook seam | Complete: typed hook registry/runner and scheduler adapter. | No migration work. |
| Tool execution | Complete: typed lifecycle, approval path, central policy, audit, and per-file serialization. | No migration work. |
| Crash recovery | Complete for turn and session recovery: persisted checkpoints plus replay classes. | Maintain with focused recovery tests. |
| File history | Complete for checkpoint history: isolated shadow Git repository. | Keep it separate from the user's Git history. |
| Per-tool interactive undo | Not implemented as a product action. | Deliberately deferred: automatic rollback can conflict with later edits or irreversible operations. Add only with a confirmed UI flow, a preimage contract, approval, and audit. |
| Generic external result store | Not implemented. | Deliberately deferred: current tool summaries, session persistence, and compression have consumers; a generic store would create an ownerless second truth source. |

## Minimal Change Policy

1. Write or update the mapping and acceptance test before adding an abstraction.
2. Extend an existing Otto owner when it already owns the state.
3. Add a new interface only when two real callers need the same boundary.
4. Never add an AtomCode crate, Rust binary, FFI bridge, or wire protocol as a
   runtime dependency for this purpose.
5. For destructive tools, require Otto confirmation, policy, and audit paths;
   recovery metadata is not permission to replay an action.

## Review Checklist

- Does the change preserve `TurnStateMachine` as the only turn-state truth?
- Does it preserve `ToolExecutionEngine` and `CentralPolicy` as the only
  execution decision path?
- Is a new checkpoint, history, or result store backed by one concrete
  consumer and a recovery test?
- Does the change avoid importing AtomCode code or protocol definitions?
- Is the user-visible behavior typed, auditable, and reversible where safe?
