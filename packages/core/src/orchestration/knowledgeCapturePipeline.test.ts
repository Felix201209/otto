/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  KnowledgeCapturePipeline,
  formatKnowledgeCaptureStatus,
} from './knowledgeCapturePipeline.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('KnowledgeCapturePipeline', () => {
  it('captures a completed agent turn once and writes a reusable work result', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-capture-'));
    tempDirs.push(root);
    const log = vi.fn(async () => undefined);
    const now = new Date('2026-07-21T12:00:00.000Z');
    const pipeline = new KnowledgeCapturePipeline({
      rootDir: root,
      now: () => now,
      workLogger: { log },
    });

    const input = {
      promptId: 'prompt-1',
      sessionId: 'session-1',
      projectRoot: '/workspace/otto',
      requestText: '修复登录问题并验证',
      responseText: '已修复空值判断，并通过 8 个登录测试。',
    };
    await pipeline.captureAfterAgent(input);
    await pipeline.captureAfterAgent(input);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'otto_work_result',
        entryType: 'work_result',
        taskTitle: '修复登录问题并验证',
        userInput: '修复登录问题并验证',
        details: '已修复空值判断，并通过 8 个登录测试。',
      }),
    );
    const status = await pipeline.getStatus();
    expect(status.agentEvents).toBe(1);
    expect(status.lastEventAt).toBe(now.toISOString());
  });

  it('records tool/session lifecycle while redacting credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-capture-'));
    tempDirs.push(root);
    const pipeline = new KnowledgeCapturePipeline({
      rootDir: root,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      workLogger: { log: vi.fn(async () => undefined) },
    });

    await pipeline.captureToolExecution({
      sessionId: 's1',
      projectRoot: '/workspace',
      toolName: 'shell',
      action: 'curl',
      success: true,
      inputSummary: 'Authorization: Bearer secret-token-123',
      outputSummary: 'apiKey=sk-super-secret-value',
      durationMs: 42,
    });
    await pipeline.captureSessionEnd({
      sessionId: 's1',
      projectRoot: '/workspace',
      reason: 'exit',
    });

    const status = await pipeline.getStatus();
    expect(status.toolEvents).toBe(1);
    expect(status.sessionEvents).toBe(1);
    expect(formatKnowledgeCaptureStatus(status)).toContain('工具事件 1');
    const eventFile = path.join(root, 'events', '2026-07-21.jsonl');
    const raw = await fs.readFile(eventFile, 'utf8');
    expect(raw).not.toContain('secret-token-123');
    expect(raw).not.toContain('sk-super-secret-value');
    expect(raw).toContain('[REDACTED]');
  });

  it('never persists private enterprise messaging payloads', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-capture-'));
    tempDirs.push(root);
    const pipeline = new KnowledgeCapturePipeline({
      rootDir: root,
      workLogger: { log: vi.fn(async () => undefined) },
    });

    await pipeline.captureToolExecution({
      toolName: 'enterprise_collaboration',
      action: 'send a private employee message',
      success: true,
      inputSummary: 'private employee payload',
      outputSummary: 'private employee response',
    });

    expect((await pipeline.getStatus()).toolEvents).toBe(0);
    await expect(fs.access(path.join(root, 'events'))).rejects.toThrow();
  });

  it('extracts typed durable knowledge, deduplicates by content hash, and searches it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-capture-'));
    tempDirs.push(root);
    const pipeline = new KnowledgeCapturePipeline({
      rootDir: root,
      now: () => new Date('2026-07-21T12:00:00.000Z'),
      workLogger: { log: vi.fn(async () => undefined) },
    });
    const base = {
      sessionId: 's1',
      projectRoot: '/workspace/otto',
      requestText: '请记住：以后模型切换要保留当前选择',
      responseText:
        '已修复模型回跳。决定采用乐观状态，失败时回滚，并通过状态测试。',
    };
    await pipeline.captureAfterAgent({ ...base, promptId: 'p1' });
    await pipeline.captureAfterAgent({ ...base, promptId: 'p2' });

    const index = JSON.parse(
      await fs.readFile(path.join(root, 'memory-index.json'), 'utf8'),
    );
    const types = new Set(
      index.records.map((record: { type: string }) => record.type),
    );
    expect(types.has('preference')).toBe(true);
    expect(types.has('decision')).toBe(true);
    expect(types.has('bugfix')).toBe(true);
    expect(
      index.records.every((record: { contentHash?: string }) =>
        Boolean(record.contentHash),
      ),
    ).toBe(true);
    expect(
      index.records.every(
        (record: { content?: string }) => record.content === undefined,
      ),
    ).toBe(true);
    expect(
      index.records.some(
        (record: { occurrences: number }) => record.occurrences === 2,
      ),
    ).toBe(true);

    const matches = await pipeline.searchKnowledge('模型切换失败回滚', {
      projectRoot: '/workspace/otto',
      limit: 5,
    });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].record.content).toContain('模型');
    const status = await pipeline.getStatus();
    expect(status.knowledgeRecords).toBe(index.records.length);
    expect(status.deduplicatedKnowledge).toBeGreaterThan(0);
  });

  it('reads the legacy knowledge/index.json and migrates new writes to memory-index.json', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-capture-'));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, 'knowledge'), { recursive: true });
    const legacyRecord = {
      version: 1,
      id: 'bugfix-legacy',
      contentHash: 'legacy-hash',
      type: 'bugfix',
      title: '模型切换',
      content: '模型切换回跳已经修复。',
      keywords: ['模型切换', '回跳'],
      source: 'after_agent',
      projectRoot: '/workspace/otto',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      occurrences: 1,
    };
    await fs.writeFile(
      path.join(root, 'knowledge', 'bugfix-legacy.json'),
      JSON.stringify(legacyRecord),
    );
    await fs.writeFile(
      path.join(root, 'knowledge', 'index.json'),
      JSON.stringify({
        version: 1,
        records: [
          {
            ...legacyRecord,
            source: undefined,
            version: undefined,
            file: 'bugfix-legacy.json',
          },
        ],
      }),
    );
    const pipeline = new KnowledgeCapturePipeline({
      rootDir: root,
      workLogger: { log: vi.fn(async () => undefined) },
    });

    expect(
      (await pipeline.searchKnowledge('模型切换回跳')).map(
        (item) => item.record.id,
      ),
    ).toContain('bugfix-legacy');
    await pipeline.captureAfterAgent({
      promptId: 'new-prompt',
      projectRoot: '/workspace/otto',
      requestText: '修复恢复流程',
      responseText: '已修复恢复流程，并通过测试。',
    });

    const primary = JSON.parse(
      await fs.readFile(path.join(root, 'memory-index.json'), 'utf8'),
    );
    expect(
      primary.records.some(
        (record: { id: string }) => record.id === 'bugfix-legacy',
      ),
    ).toBe(true);
    expect(
      primary.records.every(
        (record: { content?: string }) => record.content === undefined,
      ),
    ).toBe(true);
  });

  it('bounds prompt dedupe memory and the durable knowledge index for long-running Otto sessions', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-capture-'));
    tempDirs.push(root);
    const log = vi.fn(async () => undefined);
    let tick = 0;
    const pipeline = new KnowledgeCapturePipeline({
      rootDir: root,
      workLogger: { log },
      maxPromptIds: 2,
      maxKnowledgeRecords: 2,
      now: () => new Date(Date.UTC(2026, 6, 21, 12, 0, tick++)),
    });
    const capture = (promptId: string, value: string) =>
      pipeline.captureAfterAgent({
        promptId,
        projectRoot: '/workspace',
        requestText: `请记住偏好：${value}`,
        responseText: '好的，已经记录。',
      });

    await capture('p1', '甲');
    await capture('p2', '乙');
    await capture('p3', '丙');
    await capture('p1', '甲'); // p1 was evicted from the bounded prompt-id LRU.

    expect(log).toHaveBeenCalledTimes(4);
    const index = JSON.parse(
      await fs.readFile(path.join(root, 'memory-index.json'), 'utf8'),
    );
    expect(index.records).toHaveLength(2);
    const recordFiles = (await fs.readdir(path.join(root, 'knowledge'))).filter(
      (file) => file.endsWith('.json'),
    );
    expect(recordFiles).toHaveLength(2);
  });
});
