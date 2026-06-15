/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/EasyCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DelegateToAgentTool,
  formatClaudeCodeTaskResult,
  isAcpDelegateTask,
} from './delegate-agent.js';
import type { Config } from '../config/config.js';
import * as acpClient from '../acp-client/acpAgentClient.js';
import { getBackgroundTaskManager } from '../services/backgroundTaskManager.js';

vi.mock('../acp-client/acpAgentClient.js', () => ({
  runDelegatedTask: vi.fn(),
}));

const runDelegatedTask = vi.mocked(acpClient.runDelegatedTask);

function makeTool(targetDir = '/proj') {
  const config = {
    getTargetDir: () => targetDir,
  } as unknown as Config;
  return new DelegateToAgentTool(config);
}

describe('DelegateToAgentTool', () => {
  beforeEach(() => {
    runDelegatedTask.mockReset();
    // Clear the singleton between tests so tasks don't accumulate.
    const mgr = getBackgroundTaskManager();
    mgr.clearAllTasks();
  });

  it('rejects an empty task', async () => {
    const tool = makeTool();
    const res = await tool.execute({ task: '   ' }, new AbortController().signal);
    expect(res.status).toBe('failed');
    expect(runDelegatedTask).not.toHaveBeenCalled();
  });

  it('returns immediately with a Task ID (async mode)', async () => {
    // Make runDelegatedTask hang forever so we can observe the early return.
    runDelegatedTask.mockReturnValue(new Promise(() => {}));

    const tool = makeTool('/my/project');
    const res = await tool.execute(
      { task: 'add unit tests for foo' },
      new AbortController().signal,
    );

    // Should return immediately with status 'success' (meaning the launch succeeded).
    expect(res.status).toBe('success');
    expect(res.returnDisplay).toContain('Task ID:');
    expect(res.returnDisplay).toContain('Claude Code');
    expect(res.llmContent).toContain('"status":"running"');
    expect(res.llmContent).toContain('"taskId"');
  });

  it('defaults cwd to the project target dir', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'success',
      label: 'Claude Code',
      answer: 'Done',
      transcript: 'Done',
      stopReason: 'end_turn',
    });

    const tool = makeTool('/my/project');
    await tool.execute({ task: 'add tests' }, new AbortController().signal);

    // Wait a tick for the async task to start.
    await vi.waitFor(() => {
      expect(runDelegatedTask).toHaveBeenCalledTimes(1);
    });
    const arg = runDelegatedTask.mock.calls[0][0];
    expect(arg.agentType).toBe('claude-code');
    expect(arg.cwd).toBe('/my/project');
    expect(arg.autoApprove).toBe(true);
  });

  it('honors an explicit cwd', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'success',
      label: 'Claude Code',
      answer: 'ok',
      transcript: 'ok',
      stopReason: 'end_turn',
    });
    const tool = makeTool('/default');
    await tool.execute(
      { task: 'do x', cwd: '/explicit' },
      new AbortController().signal,
    );
    await vi.waitFor(() => {
      expect(runDelegatedTask).toHaveBeenCalledTimes(1);
    });
    expect(runDelegatedTask.mock.calls[0][0].cwd).toBe('/explicit');
  });

  it('completes the background task when runDelegatedTask succeeds', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'success',
      label: 'Claude Code',
      answer: 'Done: added tests',
      transcript: '🔧 Edit\nDone: added tests',
      stopReason: 'end_turn',
    });

    const tool = makeTool();
    const res = await tool.execute({ task: 'add tests' }, new AbortController().signal);
    const llmStr = typeof res.llmContent === 'string' ? res.llmContent : JSON.stringify(res.llmContent);
    const taskIdMatch = llmStr.match(/"taskId":"([^"]+)"/);
    expect(taskIdMatch).toBeTruthy();
    const taskId = taskIdMatch![1];

    // Wait for the async completion.
    await vi.waitFor(() => {
      const task = getBackgroundTaskManager().getTask(taskId);
      expect(task?.status).toBe('completed');
    });

    const bgTask = getBackgroundTaskManager().getTask(taskId)!;
    expect(bgTask.answer).toBe('Done: added tests');
    expect(bgTask.kind).toBe('claude-code');
  });

  it('fails the background task when runDelegatedTask fails', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'failed',
      label: 'Claude Code',
      answer: '',
      transcript: '',
      error: 'Could not launch Claude Code. Make sure it is installed.',
    });

    const tool = makeTool();
    const res = await tool.execute({ task: 'do x' }, new AbortController().signal);
    const llmStr = typeof res.llmContent === 'string' ? res.llmContent : JSON.stringify(res.llmContent);
    const taskIdMatch = llmStr.match(/"taskId":"([^"]+)"/);
    const taskId = taskIdMatch![1];

    await vi.waitFor(() => {
      const task = getBackgroundTaskManager().getTask(taskId);
      expect(task?.status).toBe('failed');
    });

    const bgTask = getBackgroundTaskManager().getTask(taskId)!;
    expect(bgTask.error).toContain('Could not launch Claude Code');
  });

  it('rejects an unknown agent value', async () => {
    const tool = makeTool();
    const res = await tool.execute(
      // intentionally not narrowing the type so the validator sees the bad value
      { task: 'do x', agent: 'gemini-cli' as never },
      new AbortController().signal,
    );
    expect(res.status).toBe('failed');
    expect(runDelegatedTask).not.toHaveBeenCalled();
  });

  it('defaults agent to claude-code and tags the background task accordingly', async () => {
    runDelegatedTask.mockReturnValue(new Promise(() => {}));
    const tool = makeTool('/proj');
    const res = await tool.execute({ task: 'do x' }, new AbortController().signal);
    expect(res.returnDisplay).toContain('Claude Code');
    await vi.waitFor(() => {
      expect(runDelegatedTask).toHaveBeenCalledTimes(1);
    });
    expect(runDelegatedTask.mock.calls[0][0].agentType).toBe('claude-code');

    const llmStr = typeof res.llmContent === 'string' ? res.llmContent : JSON.stringify(res.llmContent);
    const taskId = llmStr.match(/"taskId":"([^"]+)"/)![1];
    const task = getBackgroundTaskManager().getTask(taskId);
    expect(task?.kind).toBe('claude-code');
    expect(task?.command).toMatch(/^\[Claude Code\]/);
  });

  it('threads agent="codex" through to runDelegatedTask and tags the background task', async () => {
    runDelegatedTask.mockReturnValue(new Promise(() => {}));
    const tool = makeTool('/proj');
    const res = await tool.execute(
      { task: 'refactor auth', agent: 'codex' },
      new AbortController().signal,
    );

    // User-visible launch banner names Codex, not Claude Code.
    expect(res.returnDisplay).toContain('Codex');
    expect(res.returnDisplay).not.toContain('Claude Code');

    await vi.waitFor(() => {
      expect(runDelegatedTask).toHaveBeenCalledTimes(1);
    });
    expect(runDelegatedTask.mock.calls[0][0].agentType).toBe('codex');

    // The background task is tagged with kind:'codex' and a [Codex] command prefix.
    const llmStr = typeof res.llmContent === 'string' ? res.llmContent : JSON.stringify(res.llmContent);
    expect(llmStr).toContain('"agent":"codex"');
    const taskId = llmStr.match(/"taskId":"([^"]+)"/)![1];
    const task = getBackgroundTaskManager().getTask(taskId)!;
    expect(task.kind).toBe('codex');
    expect(task.command).toMatch(/^\[Codex\]/);
    expect(isAcpDelegateTask(task)).toBe(true);
  });

  it('rejects an unknown mode value', async () => {
    const tool = makeTool();
    const res = await tool.execute(
      { task: 'do x', mode: 'foreground' as never },
      new AbortController().signal,
    );
    expect(res.status).toBe('failed');
    expect(runDelegatedTask).not.toHaveBeenCalled();
  });

  it('mode="stream": awaits completion and returns the final answer (does NOT register a bg task)', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'success',
      label: 'Codex',
      answer: 'Refactored auth into 3 files.',
      transcript: '🔧 edit auth.ts\nRefactored auth into 3 files.',
      stopReason: 'end_turn',
    });

    const tool = makeTool('/proj');
    const res = await tool.execute(
      { task: 'refactor auth', agent: 'codex', mode: 'stream' },
      new AbortController().signal,
    );

    expect(res.status).toBe('success');
    expect(runDelegatedTask).toHaveBeenCalledTimes(1);
    expect(runDelegatedTask.mock.calls[0][0].agentType).toBe('codex');

    // The full answer must be in llmContent so the main agent has it in
    // context (no need to wait for a system notification).
    expect(res.llmContent).toContain('Refactored auth into 3 files');
    expect(res.llmContent).toContain('"mode":"stream"');
    expect(res.llmContent).toContain('"status":"success"');

    // returnDisplay banners the outcome with the agent label.
    expect(res.returnDisplay).toContain('Codex');
    expect(res.returnDisplay).toContain('Refactored auth');

    // Stream mode must NOT create a BackgroundTask (those are for async only).
    const allTasks = getBackgroundTaskManager().getAllTasks();
    expect(allTasks).toHaveLength(0);
  });

  it('mode="stream": surfaces failure status (does not throw)', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'failed',
      label: 'Claude Code',
      answer: '',
      transcript: '',
      error: 'bridge failed to launch: ENOENT',
    });

    const tool = makeTool('/proj');
    const res = await tool.execute(
      { task: 'do x', mode: 'stream' },
      new AbortController().signal,
    );
    expect(res.status).toBe('failed');
    expect(res.llmContent).toContain('"status":"failed"');
    expect(res.llmContent).toContain('bridge failed to launch');
    expect(res.returnDisplay).toContain('failed');
  });

  it('mode="stream": surfaces cancellation', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'cancelled',
      label: 'Claude Code',
      answer: '',
      transcript: '',
      error: 'Delegated task was cancelled.',
    });

    const tool = makeTool();
    const res = await tool.execute(
      { task: 'do x', mode: 'stream' },
      new AbortController().signal,
    );
    expect(res.status).toBe('cancelled');
    expect(res.returnDisplay).toContain('cancelled');
  });

  it('mode="stream": pipes session updates to updateOutput in real time', async () => {
    // The runDelegatedTask mock invokes its onUpdate as the agent emits.
    runDelegatedTask.mockImplementation(async (opts: any) => {
      opts.onUpdate?.('📖 Read foo.ts');
      opts.onUpdate?.('🔧 Edit foo.ts');
      opts.onUpdate?.('✅ Tests pass');
      return {
        status: 'success',
        label: 'Codex',
        answer: 'Done.',
        transcript: '',
        stopReason: 'end_turn',
      };
    });

    const captured: string[] = [];
    const tool = makeTool();
    await tool.execute(
      { task: 'do x', agent: 'codex', mode: 'stream' },
      new AbortController().signal,
      (output) => captured.push(output),
    );
    expect(captured).toEqual(['📖 Read foo.ts', '🔧 Edit foo.ts', '✅ Tests pass']);
  });

  it('mode defaults to "background" when omitted (preserves legacy behavior)', async () => {
    runDelegatedTask.mockReturnValue(new Promise(() => {}));
    const tool = makeTool();
    const res = await tool.execute(
      { task: 'do x' },
      new AbortController().signal,
    );
    // Background mode returns immediately with a Task ID — same as the
    // existing async behavior, before mode was introduced.
    expect(res.llmContent).toContain('"status":"running"');
    expect(res.llmContent).toContain('"taskId"');
    expect(res.llmContent).toContain('"mode":"background"');
  });

  it('cancels the background task when runDelegatedTask is cancelled', async () => {
    runDelegatedTask.mockResolvedValue({
      status: 'cancelled',
      label: 'Claude Code',
      answer: '',
      transcript: '',
      error: 'Delegated task was cancelled.',
    });

    const tool = makeTool();
    const res = await tool.execute({ task: 'do x' }, new AbortController().signal);
    const llmStr = typeof res.llmContent === 'string' ? res.llmContent : JSON.stringify(res.llmContent);
    const taskIdMatch = llmStr.match(/"taskId":"([^"]+)"/);
    const taskId = taskIdMatch![1];

    await vi.waitFor(() => {
      const task = getBackgroundTaskManager().getTask(taskId);
      expect(task?.status).toBe('cancelled');
    });
  });
});

describe('formatClaudeCodeTaskResult', () => {
  it('formats a completed claude-code task with answer', () => {
    const now = Date.now();
    const result = formatClaudeCodeTaskResult({
      id: 'abc1234',
      command: '[Claude Code] refactor auth module',
      kind: 'claude-code',
      status: 'completed',
      startTime: now - 60_000,
      endTime: now,
      output: '🔧 Edit auth.ts\n✅ auth.ts',
      stderr: '',
      answer: 'Refactored auth module successfully.',
    });
    expect(result).toContain('Claude Code task completed');
    expect(result).toContain('abc1234');
    expect(result).toContain('Refactored auth module successfully.');
    expect(result).toContain('60 seconds');
  });

  it('formats a failed task with error', () => {
    const result = formatClaudeCodeTaskResult({
      id: 'def5678',
      command: '[Claude Code] fix bug',
      kind: 'claude-code',
      status: 'failed',
      startTime: 1000000,
      endTime: 1000030,
      output: '',
      stderr: '',
      error: 'Connection timeout',
    });
    expect(result).toContain('failed');
    expect(result).toContain('Connection timeout');
  });

  it('labels a completed codex task with "Codex", not "Claude Code"', () => {
    const now = Date.now();
    const result = formatClaudeCodeTaskResult({
      id: 'cdx9999',
      command: '[Codex] write tests',
      kind: 'codex',
      status: 'completed',
      startTime: now - 30_000,
      endTime: now,
      output: '',
      stderr: '',
      answer: 'Wrote 5 tests.',
    });
    expect(result).toContain('Codex task completed');
    expect(result).not.toContain('Claude Code task completed');
    expect(result).toContain('cdx9999');
    expect(result).toContain('Wrote 5 tests.');
  });
});

describe('isAcpDelegateTask', () => {
  const base = {
    id: 't',
    command: 'x',
    status: 'completed' as const,
    startTime: 0,
    output: '',
    stderr: '',
  };

  it('returns true for claude-code tasks', () => {
    expect(isAcpDelegateTask({ ...base, kind: 'claude-code' })).toBe(true);
  });

  it('returns true for codex tasks', () => {
    expect(isAcpDelegateTask({ ...base, kind: 'codex' })).toBe(true);
  });

  it('returns false for shell tasks', () => {
    expect(isAcpDelegateTask({ ...base, kind: 'shell' })).toBe(false);
  });

  it('returns false for tasks with no kind', () => {
    expect(isAcpDelegateTask({ ...base })).toBe(false);
  });
});
