/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Debate runtime state (process-singleton, in-memory only).
 *
 * Not persisted — if the CLI restarts, an ongoing debate is lost. This is
 * intentional: the debate rounds themselves are just regular user/assistant
 * messages in the main chat history, so the conversation survives restart;
 * only the "still running, cursor at X" bookkeeping is transient.
 *
 * The state tracks a cursor = the CURRENT speaker (the one who just spoke or
 * is currently being prompted). Consumers compute the NEXT speaker locally
 * by doing `cursor + 1`, and call `advanceCursor()` only after the model
 * switch has succeeded so that cursor and `config.getModel()` stay in sync.
 */

export interface ActiveDebate {
  /** Topic string entered by the user. */
  topic: string;
  /** Participating model IDs, in speaking order. 2-3 items. */
  models: string[];
  /** Max rounds per model. 1..2. */
  rounds: number;
  /** Debate language (e.g. 'zh', 'en', or custom like '日语'). */
  language: string;
  /**
   * The CURRENT speaker position. round is 0-indexed, modelIdx is 0-indexed.
   * On debate start the cursor is (0,0) — model 0 has just been prompted
   * with the opening phrase and is about to speak.
   */
  cursor: {
    round: number;
    modelIdx: number;
  };
  /**
   * - running: auto-advance after each turn
   * - paused: cursor preserved, /debate continue will resume
   * - done: no more auto-advance; new /debate required
   */
  status: 'running' | 'paused' | 'done';
  /** Original model active before the debate started. */
  originalModel?: string;
}

let active: ActiveDebate | null = null;

/**
 * Start a fresh debate. The cursor is positioned at (round=0, modelIdx=0),
 * meaning the FIRST model is about to be prompted by the mediator with an
 * opening phrase.
 */
export function startDebate(args: {
  topic: string;
  models: string[];
  rounds: number;
  language: string;
  originalModel?: string;
}): ActiveDebate {
  if (args.models.length < 2 || args.models.length > 3) {
    throw new Error(`debate requires 2-3 models, got ${args.models.length}`);
  }
  if (args.rounds < 1 || args.rounds > 2) {
    throw new Error(`debate rounds must be 1 or 2, got ${args.rounds}`);
  }
  active = {
    topic: args.topic,
    models: [...args.models],
    rounds: args.rounds,
    language: args.language,
    cursor: { round: 0, modelIdx: 0 },
    status: 'running',
    originalModel: args.originalModel,
  };
  return active;
}

/**
 * Advance the cursor to the next speaker position. Call this ONLY after the
 * corresponding `switchModel` has completed successfully — otherwise cursor
 * and `config.getModel()` will disagree.
 *
 * Returns the updated debate, or null if no active debate. When the cursor
 * rolls past the final round, `status` is set to `done`.
 */
export function advanceCursor(): ActiveDebate | null {
  if (!active) return null;
  active.cursor.modelIdx += 1;
  if (active.cursor.modelIdx >= active.models.length) {
    active.cursor.modelIdx = 0;
    active.cursor.round += 1;
  }
  if (active.cursor.round >= active.rounds) {
    active.status = 'done';
  }
  return active;
}

/** Returns the current active debate, or null if none. */
export function getActiveDebate(): ActiveDebate | null {
  return active;
}

/**
 * Mark the debate as paused. Used on ESC / stream abort mid-round.
 * The cursor is preserved, so /debate continue can resume from the same spot.
 */
export function pauseDebate(): void {
  if (active && active.status === 'running') {
    active.status = 'paused';
  }
}

/**
 * Resume a paused debate. Returns the debate if it was paused, null otherwise.
 */
export function resumeDebate(): ActiveDebate | null {
  if (active && active.status === 'paused') {
    active.status = 'running';
    return active;
  }
  return null;
}

/** Clear the active debate entirely. */
export function endDebate(): void {
  active = null;
}

/**
 * Peek the model currently at the cursor (= the CURRENT speaker).
 * Returns null if there is no active debate.
 */
export function peekCurrentModel(): string | null {
  if (!active) return null;
  return active.models[active.cursor.modelIdx] ?? null;
}

/**
 * True if the cursor is at the very first position (round 0, modelIdx 0).
 * First speaker gets the opening phrase; all others get follow-up phrases.
 */
export function isAtOpening(): boolean {
  if (!active) return false;
  return active.cursor.round === 0 && active.cursor.modelIdx === 0;
}

/**
 * True if the given debate's cursor points at the final speaker of the final
 * round — i.e. the upcoming speech is the closing turn of the whole debate.
 *
 * Call this AFTER `advanceCursor()` (so the cursor reflects the speaker who
 * is about to talk) and BEFORE `submitQuery(followup)` — it decides whether
 * `pickFollowup` should use the "last turn" phrase pool.
 *
 * Accepts the debate explicitly (rather than reading `active`) so callers
 * can pass the snapshot they already hold, avoiding a redundant
 * `getActiveDebate()` call and any TOCTOU concerns.
 */
export function isLastTurn(debate: ActiveDebate | null | undefined): boolean {
  if (!debate) return false;
  return (
    debate.cursor.round === debate.rounds - 1 &&
    debate.cursor.modelIdx === debate.models.length - 1
  );
}
