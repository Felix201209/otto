/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * High-level entry point for the `/btw` (by-the-way) side-question flow.
 * Wraps the user's question with a system-prompt preamble that locks the
 * fork into single-shot text-only behavior, then delegates to
 * `runForkedAgent` for the actual model call.
 *
 * Calling this is safe from any context where you can get a `ContentGenerator`
 * + a fresh `AbortController`. It does NOT touch the main agent's chat
 * history, signal, or token counters.
 */

import type { Content } from '@google/genai';
import type { ContentGenerator } from '../core/contentGenerator.js';
import type { CacheSafeParams } from '../services/cacheSafeParams.js';
import { runForkedAgent, type RunForkedAgentResult } from './runForkedAgent.js';

/**
 * System-prompt boilerplate prepended to the user's question. Keeps the
 * fork model from acting as if it can take follow-up turns or call tools.
 * Updated copy here flows into both CLI and Feishu paths.
 */
export const SIDE_QUESTION_SYSTEM_PROMPT = [
  '[Otto - SIDE QUESTION FORK]',
  'You are a lightweight side-question agent answering ONE question in isolation.',
  'Constraints:',
  '- You have NO tools available. Do not pretend to call any.',
  '- This is a single-turn answer. There will be no follow-up round.',
  '- The main agent is still working in parallel — you are not interrupting it.',
  '- Do NOT say "let me try", "I will go check", "running now", or anything that implies you can take action.',
  '- Answer concisely from the provided conversation context.',
  '- If you cannot answer from the context alone, say so plainly.',
  '',
  'The user\'s side question follows:',
].join('\n');

export interface RunSideQuestionOptions {
  contentGenerator: ContentGenerator;
  model: string;
  /** The raw question text typed by the user (after stripping `/btw `). */
  question: string;
  /** Cache-safe snapshot from the main chat. Optional — falls back to cold start. */
  cacheSafeSnapshot: CacheSafeParams | null;
  /** Independent abort signal — never share with main agent. */
  signal: AbortSignal;
  /** Streaming chunks (deltas, not cumulative). */
  onChunk?: (delta: string) => void;
}

export type RunSideQuestionResult = RunForkedAgentResult;

export async function runSideQuestion(
  opts: RunSideQuestionOptions,
): Promise<RunSideQuestionResult> {
  const trimmed = (opts.question ?? '').trim();
  if (!trimmed) {
    return {
      text: '',
      status: 'failed',
      error: 'Side question is empty.',
    };
  }

  const userContent: Content = {
    role: 'user',
    parts: [{ text: `${SIDE_QUESTION_SYSTEM_PROMPT}\n\n${trimmed}` }],
  };

  return runForkedAgent({
    contentGenerator: opts.contentGenerator,
    model: opts.model,
    userContent,
    cacheSafeSnapshot: opts.cacheSafeSnapshot,
    signal: opts.signal,
    onChunk: opts.onChunk,
  });
}
