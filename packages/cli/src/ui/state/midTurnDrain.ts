/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure decision logic for the CLI mid-turn injection drain. Given the
 * current state of the prompt queue + UI flags, decide which prompts to
 * hand off to the live agent turn as additional user content, and what the
 * remaining queue should look like.
 *
 * The drain is "all or nothing": when conditions allow, every queued prompt
 * is taken at once so the model sees the full set of pending user intent in
 * one continuation. This avoids the partial-context smell where the model
 * commits to a plan based on a single appended message and is then surprised
 * by a follow-on appended later in the same turn.
 *
 * Returning `nextQueue` (instead of mutating) keeps this side-effect-free
 * and trivially testable — the React wrapper just calls `setQueuedPrompts`
 * with whatever `nextQueue` comes back.
 */
export interface MidTurnDrainResult {
  /** Prompts to inject into the running turn (preserves original order). */
  drained: string[];
  /** What the queue should look like after the drain. */
  nextQueue: string[];
}

export function computeMidTurnDrain(
  queuedPrompts: readonly string[],
  queuePaused: boolean,
  queueEditMode: boolean,
): MidTurnDrainResult {
  if (queuedPrompts.length === 0 || queuePaused || queueEditMode) {
    return { drained: [], nextQueue: queuedPrompts.slice() };
  }
  return { drained: queuedPrompts.slice(), nextQueue: [] };
}
