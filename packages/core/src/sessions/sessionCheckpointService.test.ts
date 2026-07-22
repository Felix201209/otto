/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Tests for SessionCheckpointService
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  SessionCheckpointService,
  resetCheckpointService,
} from '../sessions/sessionCheckpointService.js';

describe('SessionCheckpointService', () => {
  let tempDir: string;
  let service: SessionCheckpointService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-cp-test-'));
    process.env.OTTO_USER_DIR = tempDir;
    service = new SessionCheckpointService(tempDir);
    resetCheckpointService();
  });

  afterEach(async () => {
    delete process.env.OTTO_USER_DIR;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('save and load', () => {
    it('should save and load a checkpoint', async () => {
      const cp = await service.save({
        sessionId: 'test-session-1',
        title: 'Test Session',
        topics: ['test', 'debug'],
        lastTaskSummary: 'Fixing a bug in the auth module',
        turnCount: 5,
        contextSummary: 'User asked to fix auth bug; agent investigated and found root cause',
        wasCompressed: false,
        lastActiveAt: new Date().toISOString(),
        channel: 'cli',
      });

      expect(cp.sessionId).toBe('test-session-1');
      expect(cp.timestamp).toBeDefined();

      const loaded = await service.load('test-session-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('Test Session');
      expect(loaded!.turnCount).toBe(5);
      expect(loaded!.lastTaskSummary).toContain('auth');
    });

    it('should return null for non-existent session', async () => {
      const loaded = await service.load('nonexistent-session');
      expect(loaded).toBeNull();
    });
  });

  describe('listAll', () => {
    it('should list all checkpoints sorted by time desc', async () => {
      await service.save({
        sessionId: 'older',
        title: 'Older',
        topics: [],
        lastTaskSummary: '',
        turnCount: 1,
        contextSummary: '',
        wasCompressed: false,
        lastActiveAt: new Date(Date.now() - 60000).toISOString(),
        channel: 'cli',
      });

      await service.save({
        sessionId: 'newer',
        title: 'Newer',
        topics: [],
        lastTaskSummary: '',
        turnCount: 2,
        contextSummary: '',
        wasCompressed: false,
        lastActiveAt: new Date().toISOString(),
        channel: 'cli',
      });

      const all = await service.listAll();
      expect(all.length).toBe(2);
      expect(all[0].sessionId).toBe('newer'); // 最新的在前
    });
  });

  describe('status', () => {
    it('should report empty status when no checkpoints', async () => {
      const s = await service.status();
      expect(s.totalCheckpoints).toBe(0);
      expect(s.latest).toBeNull();
      expect(s.hasPendingTask).toBe(false);
    });

    it('should detect stalled checkpoint as pending', async () => {
      // 保存一个 "卡住的" 检查点（lastActiveAt 是 60 分钟前）
      await service.save({
        sessionId: 'stalled-session',
        title: 'Stalled Task',
        topics: [],
        lastTaskSummary: 'Deploying to production',
        turnCount: 10,
        contextSummary: 'Complex deployment task in progress',
        wasCompressed: false,
        lastActiveAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        channel: 'cli',
      });

      const s = await service.status();
      expect(s.totalCheckpoints).toBe(1);
      expect(s.hasPendingTask).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete a checkpoint', async () => {
      await service.save({
        sessionId: 'to-delete',
        title: 'Delete Me',
        topics: [],
        lastTaskSummary: '',
        turnCount: 1,
        contextSummary: '',
        wasCompressed: false,
        lastActiveAt: new Date().toISOString(),
        channel: 'cli',
      });

      const deleted = await service.delete('to-delete');
      expect(deleted).toBe(true);

      const loaded = await service.load('to-delete');
      expect(loaded).toBeNull();
    });
  });

  describe('formatStatus', () => {
    it('should output readable status text', async () => {
      await service.save({
        sessionId: 'format-test',
        title: 'Format Test Session',
        topics: ['test'],
        lastTaskSummary: 'Testing formatStatus output',
        turnCount: 3,
        contextSummary: 'Testing',
        wasCompressed: false,
        lastActiveAt: new Date().toISOString(),
        channel: 'desktop',
      });

      const formatted = await service.formatStatus();
      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('Checkpoint Status');
      expect(formatted).toContain('Format Test Session');
    });
  });
});
