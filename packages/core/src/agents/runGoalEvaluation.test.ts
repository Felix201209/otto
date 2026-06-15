/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runGoalEvaluation,
  GOAL_EVALUATION_SYSTEM_PROMPT,
} from './runGoalEvaluation.js';
import type { CacheSafeParams } from '../services/cacheSafeParams.js';
import type { ContentGenerator } from '../core/contentGenerator.js';

function makeStreamingGen(textChunks: string[]): ContentGenerator {
  return {
    generateContentStream: vi.fn(async () => {
      return (async function* () {
        for (const t of textChunks) {
          yield { candidates: [{ content: { parts: [{ text: t }] } }] } as never;
        }
      })();
    }),
    generateContent: vi.fn(),
  } as unknown as ContentGenerator;
}

const SNAPSHOT: CacheSafeParams = {
  model: 'gemini-2.0-flash-001',
  contents: [
    { role: 'user', parts: [{ text: 'history u' }] },
    { role: 'model', parts: [{ text: 'history m' }] },
  ],
  systemInstruction: 'sys',
  timestamp: 0,
};

describe('runGoalEvaluation', () => {
  it('wraps evaluation inputs with GOAL_EVALUATION_SYSTEM_PROMPT', async () => {
    const gen = makeStreamingGen(['[GOAL_EVALUATION: APPROVED] All targets met.']);
    const result = await runGoalEvaluation({
      contentGenerator: gen,
      model: 'deepseek-v4-flash',
      task: 'Migrate to React 19',
      criteria: '1. All code compiled\n2. No errors',
      reason: 'I compiled everything and verified it works.',
      cacheSafeSnapshot: SNAPSHOT,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('approved');
    expect(result.feedback).toBe('[GOAL_EVALUATION: APPROVED] All targets met.');

    const call = (gen.generateContentStream as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.config.systemInstruction).toBe(GOAL_EVALUATION_SYSTEM_PROMPT);
    const lastContent = call.contents[call.contents.length - 1];
    const wrapped = lastContent.parts[0].text;
    expect(wrapped).toContain('React 19');
    expect(wrapped).toContain('All code compiled');
    expect(wrapped).toContain('I compiled everything');
  });

  it('correctly reports rejected status when output does not contain APPROVED', async () => {
    const gen = makeStreamingGen(['[GOAL_EVALUATION: REJECTED] You forgot React DOM migration.']);
    const result = await runGoalEvaluation({
      contentGenerator: gen,
      model: 'deepseek-v4-flash',
      task: 'Migrate to React 19',
      criteria: '1. All code compiled\n2. No errors',
      reason: 'I compiled everything.',
      cacheSafeSnapshot: SNAPSHOT,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('rejected');
    expect(result.feedback).toBe('[GOAL_EVALUATION: REJECTED] You forgot React DOM migration.');
  });

  it('correctly handles failed generator invocation', async () => {
    const mockGenerator = {
      generateContentStream: vi.fn().mockRejectedValue(new Error('Quota exceeded')),
      generateContent: vi.fn(),
    } as unknown as ContentGenerator;

    const result = await runGoalEvaluation({
      contentGenerator: mockGenerator,
      model: 'deepseek-v4-flash',
      task: 'Migrate to React 19',
      criteria: '1. All code compiled\n2. No errors',
      reason: 'I compiled everything.',
      cacheSafeSnapshot: SNAPSHOT,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe('failed');
    expect(result.feedback).toContain('Quota exceeded');
  });
});
