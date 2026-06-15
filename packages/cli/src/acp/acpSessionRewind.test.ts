/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Content } from '@google/genai';
import { MESSAGE_ROLES, type GeminiChat, type Config } from 'otto-core';
import type * as acp from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../config/settings.js';
import { Session, truncateUiHistoryByUserMessageCount } from './acpSession.js';

/**
 * Build a minimal GeminiChat stub that backs `getHistory(false)` /
 * `setHistory()` with a plain in-memory array. Lets us exercise the
 * truncation logic in isolation without spinning up the real proxy auth /
 * network stack.
 */
function makeFakeChat(initial: Content[]): {
  chat: GeminiChat;
  getStored: () => Content[];
} {
  let stored: Content[] = [...initial];
  const chat = {
    getHistory: vi.fn((curated: boolean = false) => {
      void curated;
      return [...stored];
    }),
    setHistory: vi.fn((next: Content[]) => {
      stored = [...next];
    }),
    addHistory: vi.fn((c: Content) => {
      stored.push(c);
    }),
  } as unknown as GeminiChat;
  return { chat, getStored: () => stored };
}

function makeSession(
  history: Content[],
  options: { projectRoot?: string } = {},
): {
  session: Session;
  getHistory: () => Content[];
} {
  const { chat, getStored } = makeFakeChat(history);
  // No `getProjectRoot` / no `cwd` → persistTruncatedHistory short-circuits
  // before touching the filesystem (returns `persisted: false`).
  const config = {
    getDebugMode: () => false,
    ...(options.projectRoot
      ? { getProjectRoot: () => options.projectRoot }
      : {}),
  } as unknown as Config;
  const connection = {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
  } as unknown as acp.AgentSideConnection;
  const settings = {} as unknown as LoadedSettings;
  const session = new Session(
    'test-session',
    chat,
    config,
    connection,
    settings,
  );
  return { session, getHistory: getStored };
}

const userText = (text: string): Content => ({
  role: MESSAGE_ROLES.USER,
  parts: [{ text }],
});
const modelText = (text: string): Content => ({
  role: MESSAGE_ROLES.MODEL,
  parts: [{ text }],
});
const toolResponse = (name: string, response: unknown): Content => ({
  role: MESSAGE_ROLES.USER,
  parts: [
    {
      functionResponse: {
        name,
        response: response as Record<string, unknown>,
      },
    },
  ],
});

describe('Session.rewindToBeforeUserMessage', () => {
  it('keeps everything when index is past the last user message', async () => {
    const history: Content[] = [
      userText('Q1'),
      modelText('A1'),
      userText('Q2'),
      modelText('A2'),
    ];
    const { session, getHistory } = makeSession(history);

    const stats = await session.rewindToBeforeUserMessage(99);

    expect(getHistory()).toEqual(history);
    expect(stats.keptContentCount).toBe(4);
    expect(stats.droppedContentCount).toBe(0);
    // No projectRoot / cwd configured → persistence is a no-op.
    expect(stats.persisted).toBe(false);
  });

  it('truncates everything when index is 0', async () => {
    const { session, getHistory } = makeSession([
      userText('Q1'),
      modelText('A1'),
      userText('Q2'),
      modelText('A2'),
    ]);

    const stats = await session.rewindToBeforeUserMessage(0);

    expect(getHistory()).toEqual([]);
    expect(stats.keptContentCount).toBe(0);
    expect(stats.droppedContentCount).toBe(4);
  });

  it('keeps the prefix before the N-th user message', async () => {
    const { session, getHistory } = makeSession([
      userText('Q1'),
      modelText('A1'),
      userText('Q2'),
      modelText('A2'),
      userText('Q3'),
      modelText('A3'),
    ]);

    // Truncate to before the 1st user message (0-based) → keep only Q0/A0.
    const stats = await session.rewindToBeforeUserMessage(1);

    expect(getHistory()).toEqual([userText('Q1'), modelText('A1')]);
    expect(stats.keptContentCount).toBe(2);
    expect(stats.droppedContentCount).toBe(4);
  });

  it('does NOT count tool-result turns as user messages', async () => {
    // Real conversations interleave `role: user, parts: [{ functionResponse }]`
    // entries that aren't user-typed text. The rewind index is meant to map
    // 1:1 with the bubbles the IDE shows the user, so those turns must be
    // skipped when counting.
    const { session, getHistory } = makeSession([
      userText('Q1'), // 0th real user msg
      modelText('A1: I will use a tool'),
      toolResponse('shell', { stdout: 'hi' }), // role:user but tool result
      modelText('A1 final'),
      userText('Q2'), // 1st real user msg
      modelText('A2'),
    ]);

    const stats = await session.rewindToBeforeUserMessage(1);

    // Should keep Q1 + tool turn + final answer, drop Q2 + A2.
    expect(getHistory()).toEqual([
      userText('Q1'),
      modelText('A1: I will use a tool'),
      toolResponse('shell', { stdout: 'hi' }),
      modelText('A1 final'),
    ]);
    expect(stats.keptContentCount).toBe(4);
    expect(stats.droppedContentCount).toBe(2);
  });

  it('rejects negative or non-finite indices', async () => {
    const { session } = makeSession([userText('Q1')]);
    await expect(session.rewindToBeforeUserMessage(-1)).rejects.toThrow();
    await expect(session.rewindToBeforeUserMessage(NaN)).rejects.toThrow();
  });
});

// Integration tests for the on-disk persistence side-effect of rewind.
// We use a real tmpdir + the real `CoreSessionManager` so we exercise the
// full `saveSessionHistory` write path (history.json + context.json +
// metadata + index). These are the tests that catch the original bug
// ("rewind looks like it worked but the next session/load brings the old
// transcript back from disk").
describe('Session.rewindToBeforeUserMessage (persistence)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dvcode-acp-rewind-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('reports persisted:false when no projectRoot is configured', async () => {
    const { session } = makeSession([userText('Q1'), modelText('A1')]);
    const stats = await session.rewindToBeforeUserMessage(0);
    expect(stats.persisted).toBe(false);
  });

  it('rewrites history.json + context.json after a rewind', async () => {
    const { session } = makeSession(
      [
        userText('Q1'),
        modelText('A1'),
        userText('Q2'),
        modelText('A2'),
      ],
      { projectRoot: tmpRoot },
    );

    const stats = await session.rewindToBeforeUserMessage(1);
    expect(stats.keptContentCount).toBe(2);
    expect(stats.persisted).toBe(true);

    // The SessionManager constructor uses
    // `getProjectTempDir(projectRoot)` to compute its base — same as the
    // production path. We don't poke at that hash directly; instead we
    // round-trip through the SessionManager itself.
    const { SessionManager: CoreSessionManager } = await import(
      'otto-core'
    );
    const mgr = new CoreSessionManager(tmpRoot);
    const reloaded = await mgr.loadSession('test-session');
    expect(reloaded).not.toBeNull();
    // After rewind to-before-user-message-1 we kept Q1 + A1 only. The
    // clientHistory ("context.json") is the source-of-truth for the model.
    expect(reloaded!.clientHistory).toEqual([
      userText('Q1'),
      modelText('A1'),
    ]);
  });

  it('clears history.json + context.json when rewinding to index 0', async () => {
    const { session } = makeSession(
      [userText('Q1'), modelText('A1'), userText('Q2'), modelText('A2')],
      { projectRoot: tmpRoot },
    );

    const stats = await session.rewindToBeforeUserMessage(0);
    expect(stats.persisted).toBe(true);

    const { SessionManager: CoreSessionManager } = await import(
      'otto-core'
    );
    const mgr = new CoreSessionManager(tmpRoot);
    const reloaded = await mgr.loadSession('test-session');
    expect(reloaded?.clientHistory ?? []).toEqual([]);
    expect(reloaded?.history ?? []).toEqual([]);
  });
});

describe('truncateUiHistoryByUserMessageCount', () => {
  it('returns [] when keepCount is 0', () => {
    expect(
      truncateUiHistoryByUserMessageCount(
        [{ type: 'user', text: 'hi' }],
        0,
      ),
    ).toEqual([]);
  });

  it('handles gemini-cli style {type} entries', () => {
    const history = [
      { type: 'user', text: 'Q1' },
      { type: 'gemini', content: 'A1' },
      { type: 'user', text: 'Q2' },
      { type: 'gemini', content: 'A2' },
      { type: 'user', text: 'Q3' },
    ];
    expect(truncateUiHistoryByUserMessageCount(history, 2)).toEqual([
      { type: 'user', text: 'Q1' },
      { type: 'gemini', content: 'A1' },
      { type: 'user', text: 'Q2' },
      { type: 'gemini', content: 'A2' },
    ]);
  });

  it('handles native {role, parts} entries', () => {
    const history = [
      { role: 'user', parts: [{ text: 'Q1' }] },
      { role: 'model', parts: [{ text: 'A1' }] },
      { role: 'user', parts: [{ text: 'Q2' }] },
      { role: 'model', parts: [{ text: 'A2' }] },
    ];
    expect(truncateUiHistoryByUserMessageCount(history, 1)).toEqual([
      { role: 'user', parts: [{ text: 'Q1' }] },
      { role: 'model', parts: [{ text: 'A1' }] },
    ]);
  });

  it('skips functionResponse turns when counting native entries', () => {
    const history = [
      { role: 'user', parts: [{ text: 'Q1' }] },
      { role: 'model', parts: [{ functionCall: { name: 'shell' } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'shell' } }] },
      { role: 'model', parts: [{ text: 'final A1' }] },
      { role: 'user', parts: [{ text: 'Q2' }] },
    ];
    // keep 1 => everything up to (but not including) Q2.
    expect(truncateUiHistoryByUserMessageCount(history, 1)).toEqual([
      { role: 'user', parts: [{ text: 'Q1' }] },
      { role: 'model', parts: [{ functionCall: { name: 'shell' } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'shell' } }] },
      { role: 'model', parts: [{ text: 'final A1' }] },
    ]);
  });

  it('returns the full array when keepCount exceeds user-message count', () => {
    const history = [
      { type: 'user', text: 'Q1' },
      { type: 'gemini', content: 'A1' },
    ];
    expect(truncateUiHistoryByUserMessageCount(history, 99)).toEqual(history);
  });
});
