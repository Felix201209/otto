/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Tests for MemorySubsystem.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, beforeEach } from 'vitest';
import {
  createMemorySubsystem,
  type MemorySubsystem,
  type MemoryEvent,
} from './memorySubsystem.js';
import { AutoMemoryEngine } from './autoMerge.js';
import { LocalKnowledgeStore } from '../knowledge/localKnowledgeStore.js';

// ── Test helpers ────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    sourceEvent: 'test-001',
    timestamp: new Date().toISOString(),
    content: '用户偏好使用 pnpm 管理 monorepo',
    tags: ['pnpm', 'monorepo', 'tooling'],
    confidence: 0.9,
    ...overrides,
  };
}

/** 等待一个微任务 tick，让异步操作完成 */
const tick = () => new Promise<void>(r => setTimeout(r, 0));

// ── Tests ───────────────────────────────────────────────────────────────

describe('MemorySubsystem', () => {
  let subsystem: MemorySubsystem;
  let testRoot: string;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-memory-subsystem-'));
    const memoryRoot = path.join(testRoot, 'memory');
    const knowledgeRoot = path.join(testRoot, 'knowledge');
    const autoMerge = new AutoMemoryEngine({
      storageDir: memoryRoot,
      knowledgeDir: knowledgeRoot,
      globalMdPath: path.join(memoryRoot, 'global.md'),
      knowledgeJsonlPath: path.join(knowledgeRoot, 'entries.jsonl'),
    });
    await autoMerge.initialize();
    const knowledgeStore = new LocalKnowledgeStore(knowledgeRoot);
    subsystem = createMemorySubsystem({ autoMerge, knowledgeStore });
    await tick();
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  // ── capture and search ──────────────────────────────────────────────

  it('captures events and returns them via search', async () => {
    const event = makeEvent({
      content: '项目使用 React 18 + TypeScript',
      tags: ['react', 'typescript'],
    });
    await subsystem.capture(event);
    await tick();

    const results = await subsystem.search('react');
    expect(results.length).toBeGreaterThan(0);

    const match = results.find(r => r.entry.content.includes('React 18'));
    expect(match).toBeDefined();
    expect(match!.provenance).toBe('autoMerge');
    expect(match!.score).toBeGreaterThan(0);
  });

  it('returns empty array when no events match the query', async () => {
    const event = makeEvent({
      content: '项目使用 pnpm workspace',
      tags: ['pnpm'],
    });
    await subsystem.capture(event);
    await tick();

    const results = await subsystem.search('nonexistent');
    expect(results).toHaveLength(0);
  });

  it('ignores empty content events', async () => {
    const event = makeEvent({ content: '   ', confidence: 0.9 });
    await subsystem.capture(event);
    await tick();

    const stats = await subsystem.getStats();
    expect(stats.autoMergeEntries).toBe(0);
  });

  it('ignores zero-confidence events', async () => {
    const event = makeEvent({ confidence: 0 });
    await subsystem.capture(event);
    await tick();

    const stats = await subsystem.getStats();
    expect(stats.autoMergeEntries).toBe(0);
  });

  // ── tags filter ──────────────────────────────────────────────────────

  it('filters search results by tags', async () => {
    await subsystem.capture(
      makeEvent({
        content: 'CI 使用 GitHub Actions',
        tags: ['ci', 'github'],
      }),
    );
    await subsystem.capture(
      makeEvent({
        content: '部署使用 Docker Compose',
        tags: ['docker', 'deploy'],
      }),
    );
    await tick();

    // 只查带 docker 标签的
    const results = await subsystem.search('docker', { tags: ['docker'] });
    expect(results.length).toBeGreaterThan(0);

    // 所有结果应包含 docker 标签
    for (const r of results) {
      expect(r.entry.tags.some(t => t.includes('docker'))).toBe(true);
    }
  });

  it('returns empty when no events match tag filter', async () => {
    await subsystem.capture(
      makeEvent({
        content: 'something about CI',
        tags: ['ci'],
      }),
    );
    await tick();

    const results = await subsystem.search('CI', { tags: ['docker'] });
    expect(results).toEqual([]);
  });

  // ── getStats ────────────────────────────────────────────────────────

  it('returns correct stats after captures', async () => {
    await subsystem.capture(
      makeEvent({ content: 'event 1', tags: ['a'] }),
    );
    await subsystem.capture(
      makeEvent({ content: 'event 2', tags: ['b'] }),
    );
    await subsystem.capture(
      makeEvent({ content: 'event 3', tags: ['c'] }),
    );
    await tick();

    const stats = await subsystem.getStats();
    expect(stats.autoMergeEntries).toBe(3);
    expect(stats.totalEntries).toBeGreaterThanOrEqual(3);
    expect(stats.lastUpdated).toBeTruthy();
  });

  it('returns zero stats when empty', async () => {
    const stats = await subsystem.getStats();
    expect(stats.autoMergeEntries).toBe(0);
    expect(stats.knowledgeEntries).toBe(0);
    expect(stats.lastUpdated).toBeNull();
  });

  // ── rebuild from events ─────────────────────────────────────────────

  it('rebuild does not throw', async () => {
    await subsystem.capture(makeEvent({ content: 'before rebuild' }));
    await tick();

    // rebuild 应该不抛异常
    await expect(subsystem.rebuild()).resolves.toBeUndefined();
  });

  // ── disabled memory (no-op) ─────────────────────────────────────────

  it('no-ops all operations when disabled', async () => {
    const disabled = createMemorySubsystem({ disabled: true });

    // capture 不抛异常
    await expect(
      disabled.capture(
        makeEvent({ content: 'should not be saved' }),
      ),
    ).resolves.toBeUndefined();

    // search 返回空
    const results = await disabled.search('anything');
    expect(results).toEqual([]);

    // stats 返回全零
    const stats = await disabled.getStats();
    expect(stats).toEqual({
      totalEntries: 0,
      autoMergeEntries: 0,
      knowledgeEntries: 0,
      lastUpdated: null,
    });

    // rebuild / clear 不抛异常
    await expect(disabled.rebuild()).resolves.toBeUndefined();
    await expect(disabled.clear()).resolves.toBeUndefined();
  });

  it('disabled subsystem is independent of active ones', async () => {
    // 创建活跃的 subsystem
    const active = createMemorySubsystem({ autoMerge: new AutoMemoryEngine() });
    await active.capture(makeEvent({ content: 'active event' }));
    await active.getStats();

    // 禁用的不应受活跃的影响
    const disabled = createMemorySubsystem({ disabled: true });
    const stats = await disabled.getStats();
    expect(stats.totalEntries).toBe(0);
  });

  // ── provenance tracking ─────────────────────────────────────────────

  it('tracks provenance per search result', async () => {
    await subsystem.capture(
      makeEvent({ content: 'search event with provenance', tags: ['test'] }),
    );
    await tick();

    const results = await subsystem.search('provenance');
    for (const r of results) {
      expect(['autoMerge', 'knowledgeStore']).toContain(r.provenance);
    }
  });

  // ── minConfidence filter ─────────────────────────────────────────────

  it('filters results by minConfidence', async () => {
    // A 0.7 event is indexed by autoMerge but is not promoted to the
    // high-confidence knowledge store, so minConfidence 0.8 filters it out.
    await subsystem.capture(
      makeEvent({ content: 'confidence test', confidence: 0.7 }),
    );
    await tick();

    const results = await subsystem.search('confidence', { minConfidence: 0.8 });
    // autoMerge 条目的置信度固定为 0.7，低于 0.8，会被过滤
    expect(results).toHaveLength(0);
  });

  // ── limit option ─────────────────────────────────────────────────────

  it('respects search limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await subsystem.capture(
        makeEvent({ content: `common term event ${i}`, tags: ['batch'] }),
      );
    }
    await tick();

    const unlimited = await subsystem.search('common term');
    const limited = await subsystem.search('common term', { limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
    expect(unlimited.length).toBeGreaterThanOrEqual(limited.length);
  });
});
