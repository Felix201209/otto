/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  TurnState,
  TurnStateMachine,
  InvalidTransitionError,
  canTransitionTo,
  describeTransition,
} from './turnStateMachine.js';

describe('TurnStateMachine', () => {
  // ── Valid transitions ──────────────────────────────────────────

  it('created → planning', () => {
    const sm = new TurnStateMachine();
    expect(sm.current).toBe(TurnState.CREATED);
    sm.transition(TurnState.PLANNING);
    expect(sm.current).toBe(TurnState.PLANNING);
  });

  it('planning → executing_tool', () => {
    const sm = smAt(TurnState.PLANNING);
    sm.transition(TurnState.EXECUTING_TOOL);
    expect(sm.current).toBe(TurnState.EXECUTING_TOOL);
  });

  it('planning → awaiting_permission', () => {
    const sm = smAt(TurnState.PLANNING);
    sm.transition(TurnState.AWAITING_PERMISSION);
    expect(sm.current).toBe(TurnState.AWAITING_PERMISSION);
  });

  it('awaiting_permission → executing_tool', () => {
    const sm = smAt(TurnState.AWAITING_PERMISSION);
    sm.transition(TurnState.EXECUTING_TOOL);
    expect(sm.current).toBe(TurnState.EXECUTING_TOOL);
  });

  it('awaiting_permission → cancelled', () => {
    const sm = smAt(TurnState.AWAITING_PERMISSION);
    sm.transition(TurnState.CANCELLED);
    expect(sm.current).toBe(TurnState.CANCELLED);
  });

  it('executing_tool → observing_result', () => {
    const sm = smAt(TurnState.EXECUTING_TOOL);
    sm.transition(TurnState.OBSERVING_RESULT);
    expect(sm.current).toBe(TurnState.OBSERVING_RESULT);
  });

  it('executing_tool → failed', () => {
    const sm = smAt(TurnState.EXECUTING_TOOL);
    sm.transition(TurnState.FAILED);
    expect(sm.current).toBe(TurnState.FAILED);
  });

  it('executing_tool → cancelled', () => {
    const sm = smAt(TurnState.EXECUTING_TOOL);
    sm.transition(TurnState.CANCELLED);
    expect(sm.current).toBe(TurnState.CANCELLED);
  });

  it('observing_result → planning (loop back)', () => {
    const sm = smAt(TurnState.OBSERVING_RESULT);
    sm.transition(TurnState.PLANNING);
    expect(sm.current).toBe(TurnState.PLANNING);
  });

  it('observing_result → writing_memory', () => {
    const sm = smAt(TurnState.OBSERVING_RESULT);
    sm.transition(TurnState.WRITING_MEMORY);
    expect(sm.current).toBe(TurnState.WRITING_MEMORY);
  });

  it('observing_result → failed', () => {
    const sm = smAt(TurnState.OBSERVING_RESULT);
    sm.transition(TurnState.FAILED);
    expect(sm.current).toBe(TurnState.FAILED);
  });

  it('observing_result → cancelled', () => {
    const sm = smAt(TurnState.OBSERVING_RESULT);
    sm.transition(TurnState.CANCELLED);
    expect(sm.current).toBe(TurnState.CANCELLED);
  });

  it('writing_memory → checkpointing', () => {
    const sm = smAt(TurnState.WRITING_MEMORY);
    sm.transition(TurnState.CHECKPOINTING);
    expect(sm.current).toBe(TurnState.CHECKPOINTING);
  });

  it('writing_memory → failed', () => {
    const sm = smAt(TurnState.WRITING_MEMORY);
    sm.transition(TurnState.FAILED);
    expect(sm.current).toBe(TurnState.FAILED);
  });

  it('writing_memory → cancelled', () => {
    const sm = smAt(TurnState.WRITING_MEMORY);
    sm.transition(TurnState.CANCELLED);
    expect(sm.current).toBe(TurnState.CANCELLED);
  });

  it('checkpointing → completed', () => {
    const sm = smAt(TurnState.CHECKPOINTING);
    sm.transition(TurnState.COMPLETED);
    expect(sm.current).toBe(TurnState.COMPLETED);
  });

  it('checkpointing → failed', () => {
    const sm = smAt(TurnState.CHECKPOINTING);
    sm.transition(TurnState.FAILED);
    expect(sm.current).toBe(TurnState.FAILED);
  });

  it('checkpointing → cancelled', () => {
    const sm = smAt(TurnState.CHECKPOINTING);
    sm.transition(TurnState.CANCELLED);
    expect(sm.current).toBe(TurnState.CANCELLED);
  });

  // ── Complete happy path ────────────────────────────────────────

  it('full happy path: created → ... → completed', () => {
    const sm = new TurnStateMachine();
    sm.transition(TurnState.PLANNING);
    sm.transition(TurnState.EXECUTING_TOOL);
    sm.transition(TurnState.OBSERVING_RESULT);
    sm.transition(TurnState.WRITING_MEMORY);
    sm.transition(TurnState.CHECKPOINTING);
    sm.transition(TurnState.COMPLETED);
    expect(sm.current).toBe(TurnState.COMPLETED);
    expect(sm.isTerminal()).toBe(true);
  });

  it('full happy path with permission flow', () => {
    const sm = new TurnStateMachine();
    sm.transition(TurnState.PLANNING);
    sm.transition(TurnState.AWAITING_PERMISSION);
    sm.transition(TurnState.EXECUTING_TOOL);
    sm.transition(TurnState.OBSERVING_RESULT);
    sm.transition(TurnState.WRITING_MEMORY);
    sm.transition(TurnState.CHECKPOINTING);
    sm.transition(TurnState.COMPLETED);
    expect(sm.current).toBe(TurnState.COMPLETED);
    expect(sm.isTerminal()).toBe(true);
  });

  // ── Invalid transitions ────────────────────────────────────────

  it('throws on created → executing_tool (skips planning)', () => {
    const sm = new TurnStateMachine();
    expect(() => sm.transition(TurnState.EXECUTING_TOOL)).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws on created → completed (skips everything)', () => {
    const sm = new TurnStateMachine();
    expect(() => sm.transition(TurnState.COMPLETED)).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws on planning → completed', () => {
    const sm = smAt(TurnState.PLANNING);
    expect(() => sm.transition(TurnState.COMPLETED)).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws on executing_tool → completed', () => {
    const sm = smAt(TurnState.EXECUTING_TOOL);
    expect(() => sm.transition(TurnState.COMPLETED)).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws on executing_tool → awaiting_permission', () => {
    const sm = smAt(TurnState.EXECUTING_TOOL);
    expect(() => sm.transition(TurnState.AWAITING_PERMISSION)).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws on completed → planning (terminal state)', () => {
    const sm = smAtCompleted();
    expect(() => sm.transition(TurnState.PLANNING)).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws on failed → planning (terminal state)', () => {
    const sm = smAtFailed();
    expect(() => sm.transition(TurnState.PLANNING)).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws on cancelled → planning (terminal state)', () => {
    const sm = smAtCancelled();
    expect(() => sm.transition(TurnState.PLANNING)).toThrow(
      InvalidTransitionError,
    );
  });

  it('throws when transitioning from a terminal state', () => {
    for (const terminal of [TurnState.COMPLETED, TurnState.FAILED, TurnState.CANCELLED]) {
      for (const state of Object.values(TurnState)) {
        // A terminal → terminal is still invalid in our scheme (no self/among-terminal edges defined)
        expect(canTransitionTo(terminal, state)).toBe(false);
      }
    }
  });

  it('error message includes from and to states', () => {
    const sm = new TurnStateMachine();
    try {
      sm.transition(TurnState.COMPLETED);
      expect.fail('Expected error was not thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidTransitionError);
      const err = e as InvalidTransitionError;
      expect(err.from).toBe(TurnState.CREATED);
      expect(err.to).toBe(TurnState.COMPLETED);
      expect(err.message).toContain('created → completed');
      expect(err.message).toContain('INVALID');
    }
  });

  // ── Terminal state detection ───────────────────────────────────

  it('isTerminal returns true for completed', () => {
    expect(smAtCompleted().isTerminal()).toBe(true);
  });

  it('isTerminal returns true for failed', () => {
    expect(smAtFailed().isTerminal()).toBe(true);
  });

  it('isTerminal returns true for cancelled', () => {
    expect(smAtCancelled().isTerminal()).toBe(true);
  });

  it('isTerminal returns false for non-terminal states', () => {
    const nonTerminals = [
      TurnState.CREATED,
      TurnState.PLANNING,
      TurnState.AWAITING_PERMISSION,
      TurnState.EXECUTING_TOOL,
      TurnState.OBSERVING_RESULT,
      TurnState.WRITING_MEMORY,
      TurnState.CHECKPOINTING,
    ];
    for (const state of nonTerminals) {
      const sm = smAt(state);
      expect(sm.isTerminal()).toBe(false);
    }
  });

  // ── currentState() alias ───────────────────────────────────────

  it('currentState() returns the same as current getter', () => {
    const sm = smAt(TurnState.EXECUTING_TOOL);
    expect(sm.currentState()).toBe(sm.current);
    expect(sm.currentState()).toBe(TurnState.EXECUTING_TOOL);
  });

  // ── canTransitionTo() ──────────────────────────────────────────

  it('canTransitionTo returns true for valid transitions', () => {
    const sm = smAt(TurnState.PLANNING);
    expect(sm.canTransitionTo(TurnState.EXECUTING_TOOL)).toBe(true);
    expect(sm.canTransitionTo(TurnState.AWAITING_PERMISSION)).toBe(true);
  });

  it('canTransitionTo returns false for invalid transitions', () => {
    const sm = smAt(TurnState.PLANNING);
    expect(sm.canTransitionTo(TurnState.COMPLETED)).toBe(false);
    expect(sm.canTransitionTo(TurnState.CREATED)).toBe(false);
  });

  // ── describeTransition ─────────────────────────────────────────

  it('describeTransition marks valid transition', () => {
    expect(describeTransition(TurnState.CREATED, TurnState.PLANNING)).toBe(
      'created → planning (valid)',
    );
  });

  it('describeTransition marks invalid transition', () => {
    expect(describeTransition(TurnState.CREATED, TurnState.COMPLETED)).toBe(
      'created → completed (INVALID)',
    );
  });
});

// ── Helpers ──────────────────────────────────────────────────────

/** Create a machine force-set to the given state via successive valid transitions. */
function smAt(state: TurnState): TurnStateMachine {
  const sm = new TurnStateMachine();
  // Walk the shortest valid path to `state`
  switch (state) {
    case TurnState.CREATED:
      return sm;
    case TurnState.PLANNING:
      sm.transition(TurnState.PLANNING);
      return sm;
    default:
      throw new Error(`Unsupported test state: ${state}`);
    case TurnState.AWAITING_PERMISSION:
      sm.transition(TurnState.PLANNING);
      sm.transition(TurnState.AWAITING_PERMISSION);
      return sm;
    case TurnState.EXECUTING_TOOL:
      sm.transition(TurnState.PLANNING);
      sm.transition(TurnState.EXECUTING_TOOL);
      return sm;
    case TurnState.OBSERVING_RESULT:
      sm.transition(TurnState.PLANNING);
      sm.transition(TurnState.EXECUTING_TOOL);
      sm.transition(TurnState.OBSERVING_RESULT);
      return sm;
    case TurnState.WRITING_MEMORY:
      sm.transition(TurnState.PLANNING);
      sm.transition(TurnState.EXECUTING_TOOL);
      sm.transition(TurnState.OBSERVING_RESULT);
      sm.transition(TurnState.WRITING_MEMORY);
      return sm;
    case TurnState.CHECKPOINTING:
      sm.transition(TurnState.PLANNING);
      sm.transition(TurnState.EXECUTING_TOOL);
      sm.transition(TurnState.OBSERVING_RESULT);
      sm.transition(TurnState.WRITING_MEMORY);
      sm.transition(TurnState.CHECKPOINTING);
      return sm;
    case TurnState.COMPLETED:
      sm.transition(TurnState.PLANNING);
      sm.transition(TurnState.EXECUTING_TOOL);
      sm.transition(TurnState.OBSERVING_RESULT);
      sm.transition(TurnState.WRITING_MEMORY);
      sm.transition(TurnState.CHECKPOINTING);
      sm.transition(TurnState.COMPLETED);
      return sm;
    case TurnState.FAILED:
      sm.transition(TurnState.PLANNING);
      sm.transition(TurnState.EXECUTING_TOOL);
      sm.transition(TurnState.FAILED);
      return sm;
    case TurnState.CANCELLED:
      sm.transition(TurnState.PLANNING);
      sm.transition(TurnState.EXECUTING_TOOL);
      sm.transition(TurnState.CANCELLED);
      return sm;
  }
}

function smAtCompleted(): TurnStateMachine {
  return smAt(TurnState.COMPLETED);
}

function smAtFailed(): TurnStateMachine {
  return smAt(TurnState.FAILED);
}

function smAtCancelled(): TurnStateMachine {
  return smAt(TurnState.CANCELLED);
}
