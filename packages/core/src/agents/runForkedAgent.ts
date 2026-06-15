/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight tool-less single-turn agent fork. The main use case is the
 * `/btw` (by-the-way) side-question flow, where the user asks a question
 * while the main agent is mid-turn and expects a quick reply that does NOT:
 *   - run any tools
 *   - mutate the main agent's chat history
 *   - share an AbortSignal with the main agent
 *   - aggregate tokens into the main session counter
 *
 * The fork talks directly to `ContentGenerator.generateContentStream`,
 * bypassing the `GeminiChat` / `Turn` / `ToolExecutionEngine` stack
 * entirely. This keeps the fork dead-simple and guaranteed-side-effect-free.
 *
 * Prompt-cache prefix sharing: if `cacheSafeSnapshot` is provided, the
 * fork uses its `contents` as the prefix (= main agent's history through
 * the last successful turn) and appends a single `user` content carrying
 * the wrapped question. Falls back to constructing a one-shot context if
 * no snapshot is available (cold start, first message of session).
 */

import type { Content } from '@google/genai';
import type { ContentGenerator } from '../core/contentGenerator.js';
import type { CacheSafeParams } from '../services/cacheSafeParams.js';
import { SceneType } from '../core/sceneManager.js';

export interface RunForkedAgentOptions {
  /** The content generator to invoke (typically `geminiClient.getContentGenerator()`). */
  contentGenerator: ContentGenerator;
  /** Model id to call. */
  model: string;
  /**
   * Final user-role content to append after the cached prefix. Caller is
   * responsible for any system-prompt wrapping (`runSideQuestion` does this).
   */
  userContent: Content;
  /**
   * Optional cache-safe params snapshot. When present, its `contents` is
   * used as the request prefix (cache hit), and its `systemInstruction`
   * carries over (unless overridden by the systemInstruction parameter below).
   * When `null`/`undefined`, the fork sends only `userContent`
   * with a minimal config (no cache hit, but feature still works).
   */
  cacheSafeSnapshot: CacheSafeParams | null;
  /** Optional custom system prompt to override any snapshot instructions. */
  systemInstruction?: string;
  /** Independent abort signal. NEVER share with the main agent. */
  signal: AbortSignal;
  /** Receives streaming answer chunks (cumulative? no, deltas). */
  onChunk?: (delta: string) => void;
}

export interface RunForkedAgentResult {
  /** Concatenated answer text. */
  text: string;
  /** Final status. */
  status: 'success' | 'cancelled' | 'failed';
  /** Populated on cancelled/failed. */
  error?: string;
}

/**
 * Run a single-turn tool-less fork and return the assembled answer.
 * Always resolves — never throws — so callers can render the failure mode
 * uniformly. Cancellation via `signal.abort()` resolves with status
 * `'cancelled'` and the partial text accumulated so far.
 */
export async function runForkedAgent(
  opts: RunForkedAgentOptions,
): Promise<RunForkedAgentResult> {
  const { contentGenerator, model, userContent, cacheSafeSnapshot, signal, onChunk } = opts;

  // Build the request contents. Cache-safe path reuses the snapshot
  // prefix; cold-start path just sends the user content.
  const prefix = cacheSafeSnapshot?.contents ?? [];
  const contents: Content[] = [...prefix, userContent];

  // Tools must be empty — fork is text-only by design.
  // generationConfig stays minimal so cache invalidation surface is small.
  const config: Record<string, unknown> = { tools: [] };
  if (opts.systemInstruction !== undefined) {
    config.systemInstruction = opts.systemInstruction;
  } else if (cacheSafeSnapshot?.systemInstruction !== undefined) {
    config.systemInstruction = cacheSafeSnapshot.systemInstruction;
  }

  let text = '';

  try {
    if (signal.aborted) {
      return { text: '', status: 'cancelled', error: 'aborted before start' };
    }

    const stream = await contentGenerator.generateContentStream(
      { model, contents, config: config as Record<string, never> },
      SceneType.CHAT_CONVERSATION,
    );

    // Race the stream consumption against the abort signal.
    const abortPromise = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) return resolve('aborted');
      signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });

    for await (const chunk of stream) {
      // Check abort each iteration.
      if (signal.aborted) {
        return { text, status: 'cancelled', error: 'aborted mid-stream' };
      }
      const partText = extractText(chunk);
      if (partText) {
        text += partText;
        onChunk?.(partText);
      }
    }

    // If the consumer aborted just as the stream ended, treat as cancelled.
    if (signal.aborted) {
      return { text, status: 'cancelled', error: 'aborted at stream end' };
    }
    // Silence unused-var warning while keeping the abort race wired up for
    // future use (e.g. timeouts).
    void abortPromise;

    return { text, status: 'success' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (signal.aborted) {
      return { text, status: 'cancelled', error: msg };
    }
    return { text, status: 'failed', error: msg };
  }
}

/** Best-effort text extraction from a Gemini response chunk. */
function extractText(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') return '';
  const candidate = (chunk as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!parts || !Array.isArray(parts)) return '';
  let out = '';
  for (const p of parts) {
    if (typeof p.text === 'string') out += p.text;
  }
  return out;
}
