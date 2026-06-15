/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { runDelegatedTask } from './acpAgentClient.js';

const STUB = fileURLToPath(
  new URL('./__fixtures__/stub-acp-agent.mjs', import.meta.url),
);
const CWD = path.dirname(fileURLToPath(import.meta.url));

function nodeLaunch(args: string[] = []) {
  return { command: process.execPath, args: [STUB, ...args] };
}

describe('runDelegatedTask', () => {
  it('handshakes, auto-approves permission, and aggregates the answer', async () => {
    const updates: string[] = [];
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      launchOverride: nodeLaunch(),
      onUpdate: (o) => updates.push(o),
    });

    expect(result.status).toBe('success');
    expect(result.stopReason).toBe('end_turn');
    // Permission was auto-approved → stub echoes the selected option id.
    expect(result.answer).toContain('chose:allow');
    // The transcript surfaced the tool call and the auto-approval marker.
    expect(result.transcript).toContain('Edit src/foo.ts');
    // onUpdate received the cumulative transcript at least once.
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((u) => u.includes('chose:allow'))).toBe(true);
  }, 30_000);

  it('reports cancelled when the signal aborts mid-task', async () => {    const controller = new AbortController();
    const promise = runDelegatedTask({
      agentType: 'claude-code',
      task: 'long task',
      cwd: CWD,
      signal: controller.signal,
      shell: false,
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'hang' },
      },
    });

    // Give the child time to start and hang in prompt, then cancel.
    await new Promise((r) => setTimeout(r, 800));
    controller.abort();

    const result = await promise;
    expect(result.status).toBe('cancelled');
  }, 30_000);

  it('fails fast with guidance when the agent goes silent after starting', async () => {
    const updates: string[] = [];
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      idleTimeoutMs: 500,
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'hang' },
      },
      onUpdate: (o) => updates.push(o),
    });

    // The handshake succeeds but the prompt never streams — the idle watchdog
    // must surface this rather than hanging until the full task timeout.
    expect(result.status).toBe('timed_out');
    expect(result.error).toContain('claude /login');
    // A startup status was pushed immediately so the UI never looks frozen.
    expect(updates.length).toBeGreaterThan(0);
  }, 30_000);

  it('resumes a native session via session/load and reports its id', async () => {
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'continue the work',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      resumeSessionId: 'sess-to-resume',
      launchOverride: nodeLaunch(),
    });

    expect(result.status).toBe('success');
    // The resumed id (not the stub's fresh "stub-session-1") is surfaced.
    expect(result.sessionId).toBe('sess-to-resume');
    expect(result.answer).toContain('chose:allow');
  }, 30_000);

  it('captures structured progress (tool count, plan, token usage)', async () => {
    const snapshots: Array<{ toolCallCount: number }> = [];
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something rich',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      launchOverride: {
        command: process.execPath,
        args: [STUB],
        env: { STUB_MODE: 'rich' },
      },
      onProgress: (p) => snapshots.push({ toolCallCount: p.toolCallCount }),
    });

    expect(result.status).toBe('success');
    expect(result.progress).toBeDefined();
    expect(result.progress!.toolCallCount).toBeGreaterThanOrEqual(1);
    expect(result.progress!.currentTool).toContain('Edit src/foo.ts');
    expect(result.progress!.tokenUsed).toBe(1234);
    expect(result.progress!.tokenSize).toBe(10000);
    expect(result.progress!.plan).toHaveLength(3);
    expect(result.progress!.plan![1]).toEqual({
      content: 'Step two',
      status: 'in_progress',
    });
    // The structured callback fired during the turn.
    expect(snapshots.length).toBeGreaterThan(0);
  }, 30_000);

  it('fails with actionable guidance when the agent cannot be launched', async () => {
    const result = await runDelegatedTask({
      agentType: 'claude-code',
      task: 'do something',
      cwd: CWD,
      signal: new AbortController().signal,
      shell: false,
      launchOverride: {
        command: 'otto-nonexistent-binary-xyz',
        args: [],
      },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('Claude Code');
  }, 30_000);
});
