/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { runForkedAgent } from './runForkedAgent.js';
import type { CacheSafeParams } from '../services/cacheSafeParams.js';
import type { ContentGenerator } from '../core/contentGenerator.js';

function makeStreamingGenerator(
  chunks: Array<{ text?: string } | { _throw: Error }>,
): ContentGenerator {
  return {
    generateContentStream: vi.fn(async () => {
      return (async function* () {
        for (const c of chunks) {
          if ('_throw' in c) throw c._throw;
          yield {
            candidates: [
              { content: { parts: [{ text: c.text ?? '' }] } },
            ],
          } as never;
        }
      })();
    }),
    // Unused — only generateContentStream is exercised here.
    generateContent: vi.fn(),
  } as unknown as ContentGenerator;
}

const STUB_USER: { role: string; parts: Array<{ text: string }> } = {
  role: 'user',
  parts: [{ text: 'hi side question' }],
};

const STUB_SNAPSHOT: CacheSafeParams = {
  model: 'gemini-2.0-flash-001',
  contents: [
    { role: 'user', parts: [{ text: 'main turn 1' }] },
    { role: 'model', parts: [{ text: 'main turn 1 reply' }] },
  ],
  systemInstruction: 'system: behave',
  timestamp: 1700000000000,
};

describe('runForkedAgent', () => {
  it('concatenates streamed text chunks into a single answer', async () => {
    const gen = makeStreamingGenerator([
      { text: 'Sure, ' },
      { text: 'the answer ' },
      { text: 'is 42.' },
    ]);
    const result = await runForkedAgent({
      contentGenerator: gen,
      model: 'gemini-2.0-flash-001',
      userContent: STUB_USER,
      cacheSafeSnapshot: STUB_SNAPSHOT,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('success');
    expect(result.text).toBe('Sure, the answer is 42.');
  });

  it('invokes onChunk with deltas (not cumulative)', async () => {
    const gen = makeStreamingGenerator([
      { text: 'A' },
      { text: 'B' },
      { text: 'C' },
    ]);
    const deltas: string[] = [];
    await runForkedAgent({
      contentGenerator: gen,
      model: 'm',
      userContent: STUB_USER,
      cacheSafeSnapshot: STUB_SNAPSHOT,
      signal: new AbortController().signal,
      onChunk: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(['A', 'B', 'C']);
  });

  it('uses the snapshot prefix + appended userContent in the request', async () => {
    const gen = makeStreamingGenerator([{ text: 'ok' }]);
    await runForkedAgent({
      contentGenerator: gen,
      model: 'gemini-2.0-flash-001',
      userContent: STUB_USER,
      cacheSafeSnapshot: STUB_SNAPSHOT,
      signal: new AbortController().signal,
    });
    const call = (gen.generateContentStream as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toBe('gemini-2.0-flash-001');
    expect(call.contents).toEqual([
      ...STUB_SNAPSHOT.contents,
      STUB_USER,
    ]);
    // Cache-hit-critical: same systemInstruction passes through.
    expect(call.config.systemInstruction).toBe('system: behave');
    // Fork is tool-less by design.
    expect(call.config.tools).toEqual([]);
  });

  it('cold-start (no snapshot) sends only the userContent, no systemInstruction', async () => {
    const gen = makeStreamingGenerator([{ text: 'ok' }]);
    await runForkedAgent({
      contentGenerator: gen,
      model: 'm',
      userContent: STUB_USER,
      cacheSafeSnapshot: null,
      signal: new AbortController().signal,
    });
    const call = (gen.generateContentStream as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.contents).toEqual([STUB_USER]);
    expect(call.config.tools).toEqual([]);
    expect(call.config.systemInstruction).toBeUndefined();
  });

  it('returns cancelled and preserves partial text when signal aborts mid-stream', async () => {
    const ctrl = new AbortController();
    const gen: ContentGenerator = {
      generateContentStream: vi.fn(async () => {
        return (async function* () {
          yield {
            candidates: [{ content: { parts: [{ text: 'first ' }] } }],
          } as never;
          // Simulate user abort happening between chunks.
          ctrl.abort();
          yield {
            candidates: [{ content: { parts: [{ text: 'should not arrive' }] } }],
          } as never;
        })();
      }),
      generateContent: vi.fn(),
    } as unknown as ContentGenerator;

    const result = await runForkedAgent({
      contentGenerator: gen,
      model: 'm',
      userContent: STUB_USER,
      cacheSafeSnapshot: STUB_SNAPSHOT,
      signal: ctrl.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(result.text).toBe('first '); // partial preserved
  });

  it('returns cancelled when the signal was aborted before start', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const gen = makeStreamingGenerator([{ text: 'never run' }]);
    const result = await runForkedAgent({
      contentGenerator: gen,
      model: 'm',
      userContent: STUB_USER,
      cacheSafeSnapshot: STUB_SNAPSHOT,
      signal: ctrl.signal,
    });
    expect(result.status).toBe('cancelled');
    expect(gen.generateContentStream).not.toHaveBeenCalled();
  });

  it('returns failed (not throws) when the generator throws', async () => {
    const gen = makeStreamingGenerator([
      { text: 'partial' },
      { _throw: new Error('upstream 500') },
    ]);
    const result = await runForkedAgent({
      contentGenerator: gen,
      model: 'm',
      userContent: STUB_USER,
      cacheSafeSnapshot: STUB_SNAPSHOT,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('failed');
    expect(result.text).toBe('partial');
    expect(result.error).toContain('upstream 500');
  });

  it('handles a chunk with no text parts without crashing', async () => {
    const gen: ContentGenerator = {
      generateContentStream: vi.fn(async () => {
        return (async function* () {
          yield { candidates: [{ content: { parts: [] } }] } as never;
          yield {
            candidates: [{ content: { parts: [{ text: 'hello' }] } }],
          } as never;
        })();
      }),
      generateContent: vi.fn(),
    } as unknown as ContentGenerator;
    const result = await runForkedAgent({
      contentGenerator: gen,
      model: 'm',
      userContent: STUB_USER,
      cacheSafeSnapshot: STUB_SNAPSHOT,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('success');
    expect(result.text).toBe('hello');
  });
});
