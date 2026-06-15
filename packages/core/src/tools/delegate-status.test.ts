/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CheckDelegateStatusTool } from './delegate-status.js';
import type { Config } from '../config/config.js';
import { getBackgroundTaskManager } from '../services/backgroundTaskManager.js';

function makeTool(targetDir = '/proj') {
  const config = {
    getTargetDir: () => targetDir,
  } as unknown as Config;
  return new CheckDelegateStatusTool(config);
}

describe('CheckDelegateStatusTool', () => {
  beforeEach(() => {
    getBackgroundTaskManager().clearAllTasks();
  });

  it('returns not_found for a non-existent task', async () => {
    const tool = makeTool();
    const res = await tool.execute({ taskId: 'nonexist' }, new AbortController().signal);
    expect(res.status).toBe('not_found');
    expect(res.returnDisplay).toContain('No delegated agent task found');
  });

  it('returns not_found for a shell task (wrong kind)', async () => {
    const mgr = getBackgroundTaskManager();
    mgr.createTask('npm test', '/proj', 'shell');
    const tool = makeTool();
    const res = await tool.execute({ taskId: mgr.getAllTasks()[0].id }, new AbortController().signal);
    expect(res.status).toBe('not_found');
  });

  it('finds a running codex task (kind:"codex" is treated as ACP delegate)', async () => {
    const mgr = getBackgroundTaskManager();
    const bgTask = mgr.createTask('[Codex] add tests', '/proj', 'codex');
    mgr.appendOutput(bgTask.id, '🔧 Edit src/foo.ts\nAdding unit tests...');

    const tool = makeTool();
    const res = await tool.execute({ taskId: bgTask.id }, new AbortController().signal);
    expect(res.status).toBe('running');
  });

  it('reports completed for a codex task', async () => {
    const mgr = getBackgroundTaskManager();
    const bgTask = mgr.createTask('[Codex] refactor', '/proj', 'codex');
    bgTask.answer = 'Refactored 3 files.';
    mgr.completeTask(bgTask.id, { exitCode: 0 });

    const tool = makeTool();
    const res = await tool.execute({ taskId: bgTask.id }, new AbortController().signal);
    expect(res.status).toBe('completed');
    expect(res.returnDisplay).toContain('Refactored 3 files.');
  });

  it('reports running status with progress snapshot', async () => {
    const mgr = getBackgroundTaskManager();
    const bgTask = mgr.createTask('[Claude Code] add tests', '/proj', 'claude-code');
    mgr.appendOutput(bgTask.id, '📖 Read src/foo.ts\n✅ Read src/foo.ts\n🔧 Edit src/foo.ts\nAdding unit tests...');

    const tool = makeTool();
    const res = await tool.execute({ taskId: bgTask.id }, new AbortController().signal);
    expect(res.status).toBe('running');
    expect(res.returnDisplay).toContain('running');
    expect(res.returnDisplay).toContain('tool calls');
    expect(res.returnDisplay).toContain('Recent activity');
  });

  it('reports completed status with answer', async () => {
    const mgr = getBackgroundTaskManager();
    const bgTask = mgr.createTask('[Claude Code] refactor auth', '/proj', 'claude-code');
    mgr.appendOutput(bgTask.id, '🔧 Edit auth.ts\nRefactoring...');
    bgTask.answer = 'Refactored auth module: split into 3 files.';
    mgr.completeTask(bgTask.id, { exitCode: 0 });

    const tool = makeTool();
    const res = await tool.execute({ taskId: bgTask.id }, new AbortController().signal);
    expect(res.status).toBe('completed');
    expect(res.returnDisplay).toContain('Refactored auth module');
    expect(res.returnDisplay).toContain('✅');
  });

  it('reports failed status with error', async () => {
    const mgr = getBackgroundTaskManager();
    const bgTask = mgr.createTask('[Claude Code] fix bug', '/proj', 'claude-code');
    mgr.failTask(bgTask.id, 'Connection timeout');

    const tool = makeTool();
    const res = await tool.execute({ taskId: bgTask.id }, new AbortController().signal);
    expect(res.status).toBe('failed');
    expect(res.returnDisplay).toContain('Connection timeout');
  });

  it('rejects empty taskId', async () => {
    const tool = makeTool();
    const res = await tool.execute({ taskId: '  ' }, new AbortController().signal);
    expect(res.status).toBe('not_found');
  });
});
