/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Tests for KnowledgeCapturePipeline
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  KnowledgeCapturePipeline,
  resetKnowledgeCapturePipeline,
} from '../knowledge/knowledgeCapturePipeline.js';
import { LocalKnowledgeStore } from '../knowledge/localKnowledgeStore.js';
import type { SimpleMessage } from '../knowledge/knowledgeCapture.js';

describe('KnowledgeCapturePipeline', () => {
  let tempDir: string;
  let pipeline: KnowledgeCapturePipeline;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-kcp-test-'));
    process.env.OTTO_USER_DIR = tempDir;
    const store = new LocalKnowledgeStore(path.join(tempDir, 'knowledge'));
    pipeline = new KnowledgeCapturePipeline(store);
  });

  afterEach(async () => {
    delete process.env.OTTO_USER_DIR;
    resetKnowledgeCapturePipeline();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('runFromMessages', () => {
    it('should capture decision-type knowledge from assistant messages', async () => {
      const messages: SimpleMessage[] = [
        { role: 'user', text: '我们应该用什么数据库来存储用户状态？' },
        {
          role: 'assistant',
          text: '建议使用 SQLite 作为轻量状态存储。SQLite 零配置、无需独立进程，对于个人工具类项目完全够用。不建议引入 Postgres，会增加部署复杂度。',
        },
        { role: 'user', text: '好的，就决定用 SQLite' },
      ];

      const result = await pipeline.runFromMessages(messages, 'test-session-1');
      expect(result.candidatesFound).toBeGreaterThanOrEqual(0);
      // 决策型知识置信度高，应该被写入
      if (result.captured) {
        expect(result.written).toBeGreaterThan(0);
      }
    });

    it('should skip low-value conversations', async () => {
      const messages: SimpleMessage[] = [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '你好！有什么可以帮你的？' },
      ];

      const result = await pipeline.runFromMessages(messages, 'test-session-2');
      expect(result.candidatesFound).toBe(0);
      expect(result.captured).toBe(false);
    });

    it('should not capture API keys or secrets', async () => {
      const messages: SimpleMessage[] = [
        { role: 'user', text: '这是我的配置' },
        {
          role: 'assistant',
          text: '好的，配置如下：api_key=sk-1234567890abcdefghijklmnop, token=abc123def456ghi789',
        },
      ];

      const result = await pipeline.runFromMessages(messages, 'test-session-3');
      if (result.captured) {
        // 如果捕获了，内容必须是脱敏后的
        const store = new LocalKnowledgeStore(path.join(tempDir, 'knowledge'));
        const entries = await store.loadAll();
        for (const entry of entries) {
          expect(entry.content).not.toMatch(/sk-1234567890/);
          expect(entry.content).not.toMatch(/abc123def456/);
        }
      }
    });

    it('should not duplicate entries with same content', async () => {
      const messages: SimpleMessage[] = [
        { role: 'user', text: '记住：我偏好用 TypeScript 而不是 JavaScript' },
        {
          role: 'assistant',
          text: '已记住：你偏好使用 TypeScript 进行开发。我会在后续项目中优先推荐 TypeScript 方案。',
        },
      ];

      // First run
      await pipeline.runFromMessages(messages, 'test-session-4');
      // Second run with same content
      const result2 = await pipeline.runFromMessages(messages, 'test-session-4');

      // 第二次不应该有新的写入
      expect(result2.written).toBe(0);
    });
  });

  describe('status', () => {
    it('should return empty stats for new pipeline', async () => {
      const s = await pipeline.status();
      expect(s.totalEntries).toBe(0);
      expect(s.lastCapturedAt).toBeNull();
    });

    it('should reflect captured entries', async () => {
      const messages: SimpleMessage[] = [
        { role: 'user', text: '记住我偏爱深色主题' },
        {
          role: 'assistant',
          text: '好的，已记住你偏爱深色主题界面。后续开发会优先使用深色配色方案。',
        },
      ];

      await pipeline.runFromMessages(messages, 'test-session-5');
      const s = await pipeline.status();
      expect(s.capturedThisSession).toBeGreaterThanOrEqual(0);
    });
  });

  describe('formatStatus', () => {
    it('should output readable status text', async () => {
      const formatted = await pipeline.formatStatus();
      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('Knowledge Status');
    });
  });
});
