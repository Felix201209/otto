/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deterministic state machine for agent turn lifecycle.
 *
 * A Turn progresses through a well-defined sequence of states:
 *
 *   created → planning → executing_tool → observing_result → ...
 *                      ↘ awaiting_permission → executing_tool → ...
 *   ... → writing_memory → checkpointing → completed
 *
 * Terminal states: completed | failed | cancelled
 *
 * This module enforces valid transitions at runtime so that the agent
 * cannot accidentally skip states or enter inconsistent states.
 */

export enum TurnState {
  /** Turn has been instantiated but not yet started. */
  CREATED = 'created',
  /** The LLM is producing a plan / reasoning before acting. */
  PLANNING = 'planning',
  /** A tool call requires user confirmation before execution. */
  AWAITING_PERMISSION = 'awaiting_permission',
  /** A tool is being executed. */
  EXECUTING_TOOL = 'executing_tool',
  /** The agent is observing the result of a tool execution. */
  OBSERVING_RESULT = 'observing_result',
  /** Memory write-back is in progress (MEMORY.md, etc.). */
  WRITING_MEMORY = 'writing_memory',
  /** Checkpoint is being saved to disk. */
  CHECKPOINTING = 'checkpointing',
  /** Turn finished successfully. */
  COMPLETED = 'completed',
  /** Turn failed with an error. */
  FAILED = 'failed',
  /** Turn was cancelled by the user or an abort signal. */
  CANCELLED = 'cancelled',
}

// ─── Transition table ────────────────────────────────────────────────
// created → planning
// planning → awaiting_permission | executing_tool
// awaiting_permission → executing_tool | cancelled
// executing_tool → observing_result | failed | cancelled
// observing_result → planning | writing_memory | failed | cancelled
// writing_memory → checkpointing | failed | cancelled
// checkpointing → completed | failed | cancelled
//
// Terminal states (no outgoing transitions):
//   completed, failed, cancelled

const VALID_TRANSITIONS: ReadonlyMap<TurnState, ReadonlySet<TurnState>> =
  new Map<TurnState, ReadonlySet<TurnState>>([
    [
      TurnState.CREATED,
      new Set([TurnState.PLANNING]),
    ],
    [
      TurnState.PLANNING,
      new Set([TurnState.AWAITING_PERMISSION, TurnState.EXECUTING_TOOL]),
    ],
    [
      TurnState.AWAITING_PERMISSION,
      new Set([TurnState.EXECUTING_TOOL, TurnState.CANCELLED]),
    ],
    [
      TurnState.EXECUTING_TOOL,
      new Set([
        TurnState.OBSERVING_RESULT,
        TurnState.FAILED,
        TurnState.CANCELLED,
      ]),
    ],
    [
      TurnState.OBSERVING_RESULT,
      new Set([
        TurnState.PLANNING,
        TurnState.WRITING_MEMORY,
        TurnState.FAILED,
        TurnState.CANCELLED,
      ]),
    ],
    [
      TurnState.WRITING_MEMORY,
      new Set([
        TurnState.CHECKPOINTING,
        TurnState.FAILED,
        TurnState.CANCELLED,
      ]),
    ],
    [
      TurnState.CHECKPOINTING,
      new Set([
        TurnState.COMPLETED,
        TurnState.FAILED,
        TurnState.CANCELLED,
      ]),
    ],
  ]);

/** Terminal states — once reached the turn is done. */
const TERMINAL_STATES: ReadonlySet<TurnState> = new Set([
  TurnState.COMPLETED,
  TurnState.FAILED,
  TurnState.CANCELLED,
]);

/**
 * Describes a state transition for audit / debug logging.
 * Returns `"created → planning (valid)"` for valid transitions
 * and `"executing_tool → completed (INVALID)"` for invalid ones.
 */
export function describeTransition(from: TurnState, to: TurnState): string {
  const valid = canTransitionTo(from, to);
  return `${from} → ${to}${valid ? ' (valid)' : ' (INVALID)'}`;
}

/** Returns true if `from → to` is a valid transition. */
export function canTransitionTo(from: TurnState, to: TurnState): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed) return false;
  return allowed.has(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TurnState,
    readonly to: TurnState,
  ) {
    super(
      `Invalid turn state transition: ${describeTransition(from, to)}`,
    );
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Deterministic state machine for a single agent turn.
 *
 * Usage:
 * ```
 * const sm = new TurnStateMachine();
 * sm.transition(TurnState.PLANNING);
 * sm.transition(TurnState.EXECUTING_TOOL);
 * // sm.transition(TurnState.COMPLETED); // throws — invalid
 * ```
 */
export class TurnStateMachine {
  private _current: TurnState = TurnState.CREATED;

  /** The current state. */
  get current(): TurnState {
    return this._current;
  }

  /**
   * Transition to `to`.
   * @throws {InvalidTransitionError} if the transition is not permitted.
   */
  transition(to: TurnState): void {
    if (!canTransitionTo(this._current, to)) {
      throw new InvalidTransitionError(this._current, to);
    }
    this._current = to;
  }

  /** Returns the current state (readable alias). */
  currentState(): TurnState {
    return this._current;
  }

  /** Returns true if the current state is terminal (completed / failed / cancelled). */
  isTerminal(): boolean {
    return TERMINAL_STATES.has(this._current);
  }

  /** Returns true if `from → to` would be a valid transition. */
  canTransitionTo(to: TurnState): boolean {
    return canTransitionTo(this._current, to);
  }
}
