/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { listExternalSessions } from './sessionDiscovery.js';

const STUB = fileURLToPath(
  new URL('./__fixtures__/stub-acp-agent.mjs', import.meta.url),
);

function nodeLaunch(args: string[] = []) {
  return { command: process.execPath, args: [STUB, ...args] };
}

describe('listExternalSessions', () => {
  it('lists the native sessions reported by the bridge, newest first', async () => {
    const result = await listExternalSessions({
      agent: 'claude-code',
      shell: false,
      launchOverride: nodeLaunch(),
    });

    expect(result.supported).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.sessions).toHaveLength(2);
    // Sorted by updatedAt desc — "Newest session" (2026-06) before older.
    expect(result.sessions[0].sessionId).toBe('sess-newest');
    expect(result.sessions[0].title).toBe('Newest session');
    expect(result.sessions[0].agent).toBe('claude-code');
    expect(result.sessions[0].agentLabel).toBe('Claude Code');
    expect(result.sessions[1].sessionId).toBe('sess-older');
  }, 30_000);

  it('honors the limit', async () => {
    const result = await listExternalSessions({
      agent: 'codex',
      shell: false,
      limit: 1,
      launchOverride: nodeLaunch(),
    });
    expect(result.supported).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('sess-newest');
    expect(result.sessions[0].agent).toBe('codex');
  }, 30_000);

  it('passes the cwd filter through to the bridge', async () => {
    const result = await listExternalSessions({
      agent: 'claude-code',
      cwd: '/my/project',
      shell: false,
      launchOverride: nodeLaunch(),
    });
    expect(result.supported).toBe(true);
    // The stub echoes the requested cwd back on each session.
    expect(result.sessions.every((s) => s.cwd === '/my/project')).toBe(true);
  }, 30_000);

  it('returns a clean error (no throw) when the bridge cannot launch', async () => {
    const result = await listExternalSessions({
      agent: 'claude-code',
      shell: false,
      launchOverride: { command: 'otto-nonexistent-binary-xyz', args: [] },
    });
    expect(result.supported).toBe(false);
    expect(result.sessions).toEqual([]);
    expect(result.error).toBeTruthy();
  }, 30_000);
});
