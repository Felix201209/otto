/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';

/**
 * Snapshot of the parameters used in the last successful main-agent API
 * request. Forked agents (e.g. `/btw` side questions) can reuse the
 * `contents` prefix and `systemInstruction` to hit Gemini's prompt cache,
 * saving tokens and latency on long conversation histories.
 *
 * Stored per `GeminiChat` instance (= per chat session). Updated atomically
 * after each successful turn (both sendMessage and sendMessageStream
 * paths). A fresh chat with no completed turns will have `null` and the
 * fork must fall back to building context from scratch (no cache hit).
 */
export interface CacheSafeParams {
  /** Model id used in the request that produced this snapshot. */
  model: string;
  /**
   * Full curated history at the END of the turn (includes the model's
   * latest assistant response). A fork agent appends a new user message
   * to this and sends the combined list as its `contents`.
   */
  contents: Content[];
  /**
   * System instruction text/object that was active for that turn. The
   * fork should pass the exact same `systemInstruction` to maximise cache
   * compatibility.
   */
  systemInstruction?: unknown;
  /** Snapshot timestamp (ms since epoch) for debugging / staleness checks. */
  timestamp: number;
}

/**
 * Per-chat store for the latest cache-safe parameter snapshot. Intentionally
 * small and dependency-free so it can be plugged onto a `GeminiChat`
 * instance with zero ceremony.
 */
export class CacheSafeParamsStore {
  private snapshot: CacheSafeParams | null = null;

  set(params: CacheSafeParams): void {
    this.snapshot = params;
  }

  /** Returns the last successful snapshot, or `null` if no turn has
   *  completed yet on this chat. */
  get(): CacheSafeParams | null {
    return this.snapshot;
  }

  clear(): void {
    this.snapshot = null;
  }

  has(): boolean {
    return this.snapshot !== null;
  }
}
