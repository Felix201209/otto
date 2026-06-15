/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runSideQuestion,
  SIDE_QUESTION_SYSTEM_PROMPT,
} from './runSideQuestion.js';
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

describe('runSideQuestion', () => {
  it('wraps the question with the SIDE QUESTION system prompt', async () => {
    const gen = makeStreamingGen(['ok']);
    await runSideQuestion({
      contentGenerator: gen,
      model: 'm',
      question: 'how many tokens does the current convo use?',
      cacheSafeSnapshot: SNAPSHOT,
      signal: new AbortController().signal,
    });
    const call = (gen.generateContentStream as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const lastContent = call.contents[call.contents.length - 1];
    const wrapped = lastContent.parts[0].text;
    expect(wrapped).toContain(SIDE_QUESTION_SYSTEM_PROMPT);
    expect(wrapped).toContain('how many tokens does the current convo use?');
    // The constraints must reach the model verbatim.
    expect(wrapped).toContain('You have NO tools available');
    expect(wrapped).toContain('single-turn');
  });

  it('appends after the snapshot prefix (preserving prompt-cache layout)', async () => {
    const gen = makeStreamingGen(['ok']);
    await runSideQuestion({
      contentGenerator: gen,
      model: 'm',
      question: 'q',
      cacheSafeSnapshot: SNAPSHOT,
      signal: new AbortController().signal,
    });
    const call = (gen.generateContentStream as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // First two contents must be the snapshot's history, byte-identical.
    expect(call.contents.slice(0, 2)).toEqual(SNAPSHOT.contents);
  });

  it('rejects an empty/whitespace question without calling the model', async () => {
    const gen = makeStreamingGen(['ok']);
    const result = await runSideQuestion({
      contentGenerator: gen,
      model: 'm',
      question: '   \n  ',
      cacheSafeSnapshot: SNAPSHOT,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/empty/i);
    expect(gen.generateContentStream).not.toHaveBeenCalled();
  });

  it('forwards onChunk callback through to the streaming layer', async () => {
    const gen = makeStreamingGen(['He', 'llo', '!']);
    const deltas: string[] = [];
    const result = await runSideQuestion({
      contentGenerator: gen,
      model: 'm',
      question: 'q',
      cacheSafeSnapshot: SNAPSHOT,
      signal: new AbortController().signal,
      onChunk: (d) => deltas.push(d),
    });
    expect(result.status).toBe('success');
    expect(result.text).toBe('Hello!');
    expect(deltas).toEqual(['He', 'llo', '!']);
  });

  it('works in cold-start mode (snapshot=null) — sends only the wrapped question', async () => {
    const gen = makeStreamingGen(['answered']);
    const result = await runSideQuestion({
      contentGenerator: gen,
      model: 'm',
      question: 'cold q',
      cacheSafeSnapshot: null,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('success');
    const call = (gen.generateContentStream as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.contents).toHaveLength(1);
    expect(call.contents[0].parts[0].text).toContain('cold q');
  });
});
