/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BackgroundTaskManager,
  type BackgroundTaskEvent,
} from './backgroundTaskManager.js';
import type { DelegateProgress } from '../acp-client/acpAgentClient.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgtask-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function progress(over: Partial<DelegateProgress> = {}): DelegateProgress {
  return { toolCallCount: 0, lastActivityAt: Date.now(), ...over };
}

describe('BackgroundTaskManager structured progress', () => {
  it('merges progress fields and emits task-progress', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    const events: BackgroundTaskEvent[] = [];
    mgr.onTaskEvent((e) => events.push(e));

    const task = mgr.createTask('[Claude Code] do x', '/proj', 'claude-code');
    mgr.updateProgress(task.id, progress({
      currentTool: 'Edit foo.ts',
      toolCallCount: 3,
      plan: [{ content: 'a', status: 'completed' }],
      tokenUsed: 500,
      tokenSize: 1000,
    }));

    const updated = mgr.getTask(task.id)!;
    expect(updated.currentTool).toBe('Edit foo.ts');
    expect(updated.toolCallCount).toBe(3);
    expect(updated.plan).toEqual([{ content: 'a', status: 'completed' }]);
    expect(updated.tokenUsed).toBe(500);
    expect(updated.tokenSize).toBe(1000);
    expect(events.some((e) => e.type === 'task-progress')).toBe(true);
  });
});

describe('BackgroundTaskManager persistence', () => {
  it('persists ACP delegate tasks and reloads them in a new manager', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    const task = mgr.createTask('[Codex] build feature', '/proj', 'codex');
    task.sessionId = 'sess-123';
    mgr.updateProgress(task.id, progress({ toolCallCount: 2 }));
    mgr.completeTask(task.id, { exitCode: 0 });

    // A fresh manager pointed at the same dir recovers the task.
    const reloaded = new BackgroundTaskManager({ storageDir: dir });
    const got = reloaded.getTask(task.id);
    expect(got).toBeDefined();
    expect(got!.kind).toBe('codex');
    expect(got!.sessionId).toBe('sess-123');
    expect(got!.status).toBe('completed');
    expect(got!.restoredFromDisk).toBe(true);
  });

  it('normalizes a still-running task to failed on reload (restart recovery)', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    const task = mgr.createTask('[Claude Code] long job', '/proj', 'claude-code');
    expect(task.status).toBe('running');
    // Simulate a crash: the process dies without a terminal transition.

    const reloaded = new BackgroundTaskManager({ storageDir: dir });
    const got = reloaded.getTask(task.id)!;
    expect(got.status).toBe('failed');
    expect(got.error).toContain('重启');
    expect(got.restoredFromDisk).toBe(true);
  });

  it('does NOT persist plain shell tasks', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    mgr.createTask('npm test', '/proj', 'shell');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(0);
  });

  it('removes the on-disk record when a task is cleared', () => {
    const mgr = new BackgroundTaskManager({ storageDir: dir });
    const task = mgr.createTask('[Codex] x', '/proj', 'codex');
    mgr.completeTask(task.id, { exitCode: 0 });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    mgr.clearCompletedTasks();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('honors storageDir:null by skipping all disk I/O', () => {
    const mgr = new BackgroundTaskManager({ storageDir: null });
    const task = mgr.createTask('[Codex] x', '/proj', 'codex');
    mgr.completeTask(task.id, { exitCode: 0 });
    // No throw, task tracked in-memory only.
    expect(mgr.getTask(task.id)!.status).toBe('completed');
  });
});
