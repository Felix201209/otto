/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OttoServer } from './server.js';
import { InMemorySessionStore, type SessionRuntime } from './sessions.js';

interface CompressionClientStub {
  isCompressionInProgress(): boolean;
  tryCompressChat(
    promptId: string,
    signal: AbortSignal,
    force?: boolean,
  ): Promise<{
    originalTokenCount: number;
    newTokenCount: number;
  } | null>;
}

let temporaryHome: string;

beforeEach(() => {
  temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-auto-compress-'));
  vi.stubEnv('HOME', temporaryHome);
  vi.stubEnv('USERPROFILE', temporaryHome);
  vi.stubEnv('OTTO_USER_DIR', path.join(temporaryHome, 'user'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(temporaryHome, { recursive: true, force: true });
});

function appendMessages(
  store: InMemorySessionStore,
  sessionId: string,
  count: number,
  offset = 0,
): void {
  for (let index = 0; index < count; index += 1) {
    store.appendMessage(sessionId, {
      id: `message-${offset + index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', value: `content-${offset + index}` }],
      source: 'local',
      isStreaming: false,
      timestamp: 1_000 + offset + index,
    });
  }
}

function attachCompressionClient(
  store: InMemorySessionStore,
  sessionId: string,
  client: CompressionClientStub,
): void {
  const runtime: SessionRuntime = {
    async run() {},
    cancel() {},
    setModel() {},
    resolveToolConfirmation() {},
    async dispose() {},
    getConfig: () => ({ getOttoClient: () => client }),
  };
  store.attachRuntime(sessionId, runtime);
}

async function runMaintenanceCycles(
  server: OttoServer,
  count: number,
): Promise<void> {
  const runOnce = (
    server as unknown as { runAutoCompressionCycle(): Promise<void> }
  ).runAutoCompressionCycle.bind(server);
  for (let cycle = 0; cycle < count; cycle += 1) {
    await runOnce();
  }
}

describe('OttoServer background context compression', () => {
  it('makes zero compression/model attempts by default across repeated maintenance cycles', async () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    appendMessages(store, session.sessionId, 30);
    const tryCompressChat = vi.fn(async () => ({
      originalTokenCount: 100_000,
      newTokenCount: 20_000,
    }));
    attachCompressionClient(store, session.sessionId, {
      isCompressionInProgress: () => false,
      tryCompressChat,
    });
    const server = new OttoServer({ port: 0, mock: true, store });

    await runMaintenanceCycles(server, 12);

    expect(tryCompressChat).not.toHaveBeenCalled();
  });

  it('never forces background compression and only retries after a new message revision', async () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    appendMessages(store, session.sessionId, 30);
    const tryCompressChat = vi.fn(async () => ({
      originalTokenCount: 100_000,
      newTokenCount: 20_000,
    }));
    attachCompressionClient(store, session.sessionId, {
      isCompressionInProgress: () => false,
      tryCompressChat,
    });
    const server = new OttoServer({
      port: 0,
      mock: true,
      store,
      backgroundModelTasksEnabled: true,
    });

    await runMaintenanceCycles(server, 8);

    expect(tryCompressChat).toHaveBeenCalledTimes(1);
    expect(tryCompressChat.mock.calls[0]?.[2]).toBe(false);

    const finalMessage = store.getHistory(session.sessionId).at(-1);
    if (!finalMessage) throw new Error('expected seeded history');
    store.patchMessage(session.sessionId, finalMessage.id, {
      content: [
        { type: 'text', value: 'stream finalized without a new message' },
      ],
    });
    await runMaintenanceCycles(server, 4);
    expect(tryCompressChat).toHaveBeenCalledTimes(1);

    appendMessages(store, session.sessionId, 1, 30);
    await runMaintenanceCycles(server, 8);

    expect(tryCompressChat).toHaveBeenCalledTimes(2);
    expect(tryCompressChat.mock.calls[1]?.[2]).toBe(false);
  });

  it('does not retry a failed revision without bound while the user is idle', async () => {
    const store = new InMemorySessionStore();
    const session = store.createSession();
    appendMessages(store, session.sessionId, 30);
    const tryCompressChat = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    attachCompressionClient(store, session.sessionId, {
      isCompressionInProgress: () => false,
      tryCompressChat,
    });
    const server = new OttoServer({
      port: 0,
      mock: true,
      store,
      backgroundModelTasksEnabled: true,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runMaintenanceCycles(server, 24);
    expect(tryCompressChat).toHaveBeenCalledTimes(1);

    appendMessages(store, session.sessionId, 1, 30);
    await runMaintenanceCycles(server, 24);
    expect(tryCompressChat).toHaveBeenCalledTimes(2);
  });
});
