/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCheckpointRecoveryHistory,
  SessionCheckpointService,
} from './sessionCheckpoint.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('SessionCheckpointService', () => {
  it('atomically restores a resumable same-project session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-checkpoint-'));
    roots.push(root);
    const service = new SessionCheckpointService({
      rootDir: root,
      now: () => new Date('2026-07-21T10:00:00.000Z'),
    });
    const history = [
      { role: 'user', parts: [{ text: '修复长任务恢复' }] },
      { role: 'model', parts: [{ text: '正在处理' }] },
    ];

    await service.markTurnStarted({
      sessionId: 'session/unsafe',
      projectRoot: '/workspace/otto',
      history,
      turnCount: 3,
      pendingRequest: '继续未完成任务',
    });
    const restored = await service.restoreLatest(
      'session/unsafe',
      '/workspace/otto',
    );

    expect(restored?.history).toEqual(history);
    expect(restored?.state).toBe('running');
    expect(restored?.turnCount).toBe(3);
    expect(await fs.readdir(root)).toEqual(['session_unsafe.json']);
    if (process.platform !== 'win32') {
      expect(
        (await fs.stat(path.join(root, 'session_unsafe.json'))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it('never restores an ended session or a checkpoint from another project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-checkpoint-'));
    roots.push(root);
    const service = new SessionCheckpointService({ rootDir: root });
    await service.markTurnStarted({
      sessionId: 's1',
      projectRoot: '/workspace/a',
      history: [],
      turnCount: 1,
      pendingRequest: 'hello',
    });
    expect(await service.restoreLatest('s1', '/workspace/b')).toBeNull();
    await service.markSessionEnded('s1', '/workspace/a', 'user_exit');
    expect(await service.restoreLatest('s1', '/workspace/a')).toBeNull();
  });

  it('does not restore a normally completed ready checkpoint', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-checkpoint-'));
    roots.push(root);
    const service = new SessionCheckpointService({ rootDir: root });
    await service.markTurnStarted({
      sessionId: 's-ready',
      projectRoot: '/workspace/a',
      history: [],
      turnCount: 1,
      pendingRequest: 'complete me',
    });
    await service.markTurnReady({
      sessionId: 's-ready',
      projectRoot: '/workspace/a',
      history: [{ role: 'model', parts: [{ text: 'completed' }] }],
      turnCount: 1,
    });

    expect((await service.getStatus('s-ready'))?.state).toBe('ready');
    expect(await service.restoreLatest('s-ready', '/workspace/a')).toBeNull();
  });

  it('keeps a durable summary and last task when low-memory trimming drops middle history', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-checkpoint-'));
    roots.push(root);
    const service = new SessionCheckpointService({
      rootDir: root,
      maxBytes: 1_400,
    });
    const history = [
      { role: 'user', parts: [{ text: 'environment' }] },
      { role: 'model', parts: [{ text: 'ack' }] },
      {
        role: 'user',
        parts: [{ text: '修复长时间运行后的上下文恢复问题'.repeat(8) }],
      },
      {
        role: 'model',
        parts: [{ text: '已完成第一阶段并保留检查点'.repeat(8) }],
      },
      { role: 'user', parts: [{ text: '继续未完成的任务' }] },
    ];
    await service.markTurnStarted({
      sessionId: 's-low-memory',
      projectRoot: '/workspace',
      history,
      turnCount: 9,
      pendingRequest: '继续未完成的任务',
    });

    const restored = await service.restoreLatest('s-low-memory', '/workspace');
    expect(restored?.summary).toContain('修复长时间运行');
    expect(restored?.lastTask).toBe('继续未完成的任务');
    const recoveryHistory = buildCheckpointRecoveryHistory(restored!);
    expect(JSON.stringify(recoveryHistory)).toContain(
      'Runtime recovery summary',
    );
    expect(JSON.stringify(recoveryHistory)).toContain('继续未完成的任务');
    await service.markRecoveryApplied('s-low-memory');
    expect((await service.getStatus('s-low-memory'))?.recoveryCount).toBe(1);
    expect((await service.getStatus('s-low-memory'))?.state).toBe('running');
  });

  it('keeps the pending lastTask resumable after a turn throws', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-checkpoint-'));
    roots.push(root);
    const service = new SessionCheckpointService({ rootDir: root });
    await service.markTurnStarted({
      sessionId: 's-error',
      projectRoot: '/workspace/otto',
      history: [{ role: 'user', parts: [{ text: 'previous context' }] }],
      turnCount: 4,
      pendingRequest: '继续处理还没有完成的客户任务',
    });

    await service.markTurnInterrupted(
      's-error',
      '/workspace/otto',
      'model_stream_error',
    );

    const restored = await service.restoreLatest('s-error', '/workspace/otto');
    expect(restored?.state).toBe('running');
    expect(restored?.reason).toBe('model_stream_error');
    expect(restored?.lastTask).toBe('继续处理还没有完成的客户任务');
    expect(JSON.stringify(buildCheckpointRecoveryHistory(restored!))).toContain(
      '继续处理还没有完成的客户任务',
    );
  });

  it('never persists binary attachment data and enforces the whole-record byte cap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-checkpoint-'));
    roots.push(root);
    const service = new SessionCheckpointService({
      rootDir: root,
      maxBytes: 4_096,
    });
    const binary = 'A'.repeat(1_000_000);
    await service.markTurnStarted({
      sessionId: 's-attachment',
      projectRoot: '/workspace',
      history: [],
      turnCount: 1,
      pendingRequest: [
        { text: '分析这个附件并继续任务' },
        { inlineData: { mimeType: 'image/png', data: binary } },
      ],
    });

    const checkpointPath = path.join(root, 's-attachment.json');
    const raw = await fs.readFile(checkpointPath, 'utf8');
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(4_096);
    expect(raw).not.toContain(binary.slice(0, 100));
    expect(
      (await service.restoreLatest('s-attachment', '/workspace'))?.lastTask,
    ).toBe('分析这个附件并继续任务');
  });
});
