/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Integration tests for the full knowledge capture → store → search loop.
 *
 * Tests：
 *   1. worklog entries → pipeline.runFromMessages → store has entry
 *   2. duplicate worklog entry → skipped (fingerprint dedup)
 *   3. full loop — capture → store → search via LocalKnowledgeStore.search()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  KnowledgeCapturePipeline,
  getKnowledgeCapturePipeline,
  resetKnowledgeCapturePipeline,
} from './knowledgeCapturePipeline.js';
import { LocalKnowledgeStore } from './localKnowledgeStore.js';
import type { SimpleMessage } from './knowledgeCapture.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A realistic multi-turn conversation that should trigger capture */
function makeCapturableMessages(): SimpleMessage[] {
  return [
    { role: 'user', text: '我偏好用 TypeScript 而不是纯 JavaScript，因为类型安全更好' },
    {
      role: 'assistant',
      text: '好的，已记住你偏好 TypeScript。我会在后续项目中优先推荐 TypeScript 方案。TypeScript 的静态类型检查确实能减少运行时错误。',
    },
    { role: 'user', text: '另外，数据库方面我倾向于用 SQLite，比较轻量' },
    {
      role: 'assistant',
      text: '建议使用 SQLite 作为轻量状态存储。SQLite 零配置、无需独立进程，对于个人工具类项目完全够用。不建议引入 Postgres，会增加部署复杂度。',
    },
    {
      role: 'assistant',
      text: '另外推荐使用 Prisma 作为 ORM，它能很好地桥接 TypeScript 类型系统和数据库 schema，迁移和查询都很方便。',
    },
  ];
}

/** A short hello exchange that should NOT trigger capture */
function makeShortMessages(): SimpleMessage[] {
  return [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '你好！有什么可以帮你的？' },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KnowledgeCapturePipeline integration (capture → store → search)', () => {
  let tempDir: string;
  let pipeline: KnowledgeCapturePipeline;
  let store: LocalKnowledgeStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-loop-test-'));
    process.env.OTTO_USER_DIR = tempDir;
    store = new LocalKnowledgeStore(path.join(tempDir, 'knowledge'));
    pipeline = new KnowledgeCapturePipeline(store);
  });

  afterEach(async () => {
    delete process.env.OTTO_USER_DIR;
    resetKnowledgeCapturePipeline();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── Test 1: worklog → pipeline.run → store has entry ─────────────────
  it('should capture knowledge and store it for search', async () => {
    const messages = makeCapturableMessages();

    const result = await pipeline.runFromMessages(messages, 'session-a');
    expect(result.captured).toBe(true);
    expect(result.written).toBeGreaterThan(0);

    // Verify store actually has the entry
    const entries = await store.loadAll();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.content.includes('SQLite'))).toBe(true);

    // Search should find it
    const searchResults = await store.search('SQLite');
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].score).toBeGreaterThan(0);
  });

  // ── Test 2: duplicate worklog entry → skipped ─────────────────────────
  it('should skip duplicate entries via fingerprint dedup', async () => {
    const messages = makeCapturableMessages();

    // First run
    const result1 = await pipeline.runFromMessages(messages, 'session-b');
    expect(result1.captured).toBe(true);
    const firstWritten = result1.written;

    // Second run with identical content
    const result2 = await pipeline.runFromMessages(messages, 'session-b');
    // Should produce candidates but all should be deduplicated
    expect(result2.written).toBe(0);
    expect(result2.skippedDuplicate).toBeGreaterThanOrEqual(firstWritten);
    expect(result2.captured).toBe(false);

    // Store should still only have the original entries
    const entries = await store.loadAll();
    expect(entries.length).toBe(firstWritten);
  });

  // ── Test 3: full loop — capture → store → search ──────────────────────
  it('should complete the full capture → store → search loop', async () => {
    // Phase 1: Capture knowledge from a multi-turn conversation
    const messages = makeCapturableMessages();
    const pipelineResult = await pipeline.runFromMessages(messages, 'session-c');
    expect(pipelineResult.captured).toBe(true);
    expect(pipelineResult.written).toBeGreaterThan(0);

    // Phase 2: Verify entries persisted in the store
    const allEntries = await store.loadAll();
    expect(allEntries.length).toBeGreaterThan(0);
    for (const entry of allEntries) {
      expect(entry.id).toBeTruthy();
      expect(entry.category).toBeTruthy();
      expect(entry.content.length).toBeGreaterThan(0);
      expect(entry.fingerprint).toBeTruthy();
      expect(entry.createdAt).toBeTruthy();
    }

    // Phase 3: Search by keyword
    const tsResults = await store.search('TypeScript');
    expect(tsResults.length).toBeGreaterThan(0);
    expect(tsResults[0].score).toBeGreaterThanOrEqual(5); // exact match in content

    // Phase 4: Category-filtered search
    const prefResults = await store.search('偏好', 'preference');
    expect(prefResults.length).toBeGreaterThan(0);

    // Phase 5: Search for something NOT in the store
    const noResults = await store.search('zzz_nonexistent_zzz');
    expect(noResults).toHaveLength(0);

    // Phase 6: Status reflects captured entries
    const status = await pipeline.status();
    expect(status.totalEntries).toBeGreaterThan(0);
    expect(status.capturedThisSession).toBeGreaterThan(0);
  });

  // ── Test 4: should NOT capture short conversations ────────────────────
  it('should skip capture for short conversations', async () => {
    const messages = makeShortMessages();
    const result = await pipeline.runFromMessages(messages, 'session-d');
    expect(result.captured).toBe(false);
    expect(result.written).toBe(0);
    expect(result.candidatesFound).toBe(0);
  });

  // ── Test 5: status is observable ──────────────────────────────────────
  it('should provide observable status', async () => {
    // Initial state
    const s1 = await pipeline.status();
    expect(s1.totalEntries).toBe(0);
    expect(s1.capturedThisSession).toBe(0);

    // After capture
    await pipeline.runFromMessages(makeCapturableMessages(), 'session-e');
    const s2 = await pipeline.status();
    expect(s2.totalEntries).toBeGreaterThan(0);
    expect(s2.capturedThisSession).toBeGreaterThan(0);
    expect(s2.lastCapturedAt).toBeTruthy();
  });

  // ── Test 6: duplicate via normalized whitespace fingerprints ──────────
  it('should deduplicate entries with different whitespace formatting', async () => {
    // Write an entry manually with compact whitespace
    await store.add(
      'preference',
      'prefer dark color theme for all UIs',
      ['ui', 'preference'],
      'abcd1234abcd5678',
    );

    // Pipeline: direct insert with a differently-formatted fingerprint
    // The fingerprint() method normalizes whitespace, so "prefer  dark   color"
    // should hash identically to "prefer dark color". We verify this by
    // constructing a candidate whose normalized content matches the stored one.
    const { KnowledgeCapture } = await import('./knowledgeCapture.js');
    const capture = new KnowledgeCapture(store);

    const fp1 = capture.fingerprint('prefer dark color theme for all UIs');
    const fp2 = capture.fingerprint('prefer  dark   color  theme  for  all  UIs');
    const fp3 = capture.fingerprint('prefer\ndark\tcolor theme\nfor all\tUIs');

    // All should produce the same fingerprint
    expect(fp1).toBe(fp2);
    expect(fp1).toBe(fp3);

    // Verify the stored entry is found by the normalized fingerprint
    const found = await store.findByFingerprint(fp1);
    expect(found).toBeTruthy();
    expect(found!.content).toContain('dark color');
  });
});

describe('KnowledgeCapturePipeline singleton', () => {
  it('should return the same instance via getKnowledgeCapturePipeline', () => {
    resetKnowledgeCapturePipeline();
    const a = getKnowledgeCapturePipeline();
    const b = getKnowledgeCapturePipeline();
    expect(a).toBe(b);
    resetKnowledgeCapturePipeline();
  });
});
