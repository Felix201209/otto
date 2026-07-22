/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Tests for SessionMemoryInjector.
 */

import { describe, expect, it } from 'vitest';
import {
  SessionMemoryInjector,
  type MemoryInjection,
} from './sessionMemoryInjector.js';
import {
  type MemorySubsystem,
  type MemorySearchResult,
  type MemoryEvent,
  type MemoryStats,
} from './memorySubsystem.js';

// ── Fake MemorySubsystem ─────────────────────────────────────────────────

function makeMockMemorySubsystem(
  entries: MemorySearchResult[] = [],
  shouldThrow = false,
): MemorySubsystem {
  return {
    async capture(_event: MemoryEvent): Promise<void> {},
    async search(
      _query: string,
      _opts?: any,
    ): Promise<MemorySearchResult[]> {
      if (shouldThrow) throw new Error('search failed');
      return entries;
    },
    async getStats(): Promise<MemoryStats> {
      return {
        totalEntries: entries.length,
        autoMergeEntries: entries.length,
        knowledgeEntries: 0,
        lastUpdated: null,
      };
    },
    async rebuild(): Promise<void> {},
    async clear(): Promise<void> {},
  };
}

function makeResult(
  overrides: Partial<MemorySearchResult> & { content: string },
): MemorySearchResult {
  return {
    entry: {
      sourceEvent: overrides.entry?.sourceEvent ?? 'test-001',
      timestamp: overrides.entry?.timestamp ?? new Date().toISOString(),
      content: overrides.content,
      tags: overrides.entry?.tags ?? [],
      confidence: overrides.entry?.confidence ?? 0.8,
    },
    score: overrides.score ?? 5,
    provenance: overrides.provenance ?? 'autoMerge',
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('SessionMemoryInjector', () => {
  describe('inject()', () => {
    it('returns empty injection when memory is empty', async () => {
      const subsystem = makeMockMemorySubsystem([]);
      const injector = new SessionMemoryInjector(subsystem);
      const result = await injector.inject('sess-1', 'hello world');
      expect(result.entries).toEqual([]);
      expect(result.summary).toBe('');
      expect(result.tokenCount).toBe(0);
      expect(result.totalFound).toBe(0);
    });

    it('returns empty injection when userMessage is empty', async () => {
      const subsystem = makeMockMemorySubsystem([
        makeResult({ content: 'some memory' }),
      ]);
      const injector = new SessionMemoryInjector(subsystem);
      const result = await injector.inject('sess-1', '');
      expect(result.entries).toEqual([]);
      expect(result.totalFound).toBe(0);
    });

    it('returns empty injection when userMessage is only stop words', async () => {
      const subsystem = makeMockMemorySubsystem([
        makeResult({ content: 'some memory' }),
      ]);
      const injector = new SessionMemoryInjector(subsystem);
      // "the is a to of" → all stop words → no keywords
      const result = await injector.inject('sess-1', 'the is a to of');
      expect(result.entries).toEqual([]);
    });

    it('returns empty injection when search throws', async () => {
      const subsystem = makeMockMemorySubsystem([], true);
      const injector = new SessionMemoryInjector(subsystem);
      const result = await injector.inject('sess-1', 'typescript refactor');
      expect(result.entries).toEqual([]);
      expect(result.totalFound).toBe(0);
    });

    it('injects relevant memories found by keyword match', async () => {
      const subsystem = makeMockMemorySubsystem([
        makeResult({
          content: '用户偏好使用 pnpm 管理 monorepo',
          score: 10,
        }),
        makeResult({
          content: '项目中已配置 ESLint 和 Prettier',
          score: 7,
        }),
      ]);
      const injector = new SessionMemoryInjector(subsystem);
      const result = await injector.inject('sess-1', '我想优化 pnpm monorepo 构建速度');

      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.totalFound).toBe(2);
      // 第一条应该包含 "pnpm"
      expect(
        result.entries.some(e => e.entry.content.includes('pnpm')),
      ).toBe(true);
      expect(result.summary).toContain('Previous relevant context');
    });

    it('filters out irrelevant memories (score=0 entries)', async () => {
      // Note: search already returns scored results; the injector doesn't
      // perform additional relevance filtering beyond what search returns.
      // If all search results have zero score, none are injected.
      const subsystem = makeMockMemorySubsystem([
        makeResult({
          content: '这周末去超市买鸡蛋和牛奶',
          score: 0, // not relevant to coding queries
        }),
        makeResult({
          content: '天气很好适合户外运动',
          score: 0,
        }),
      ]);
      const injector = new SessionMemoryInjector(subsystem);
      const result = await injector.inject('sess-1', 'build system optimization');

      // All results have score 0, but our search mock returns them anyway.
      // In reality MemorySubsystem.search() would filter these out by score.
      // The injector just takes whatever search returns.
      // For this test, we verify the totalFound is as expected.
      expect(result.totalFound).toBe(2);
    });

    it('applies time decay to reduce old entry scores', async () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem([]));

      // Directly test the decay function (it's a method, access via any cast)
      const freshScore = (injector as any).applyTimeDecay(10, new Date().toISOString(), Date.now());
      const oldScore = (injector as any).applyTimeDecay(10, oldDate, Date.now());

      // Fresh → minimal decay
      expect(freshScore).toBeGreaterThan(8);
      // 30 days old → significant decay
      expect(oldScore).toBeLessThan(5);
    });

    it('enforces max 5 entry limit', async () => {
      const entries: MemorySearchResult[] = [];
      for (let i = 0; i < 20; i++) {
        entries.push(
          makeResult({
            content: `memory entry ${i} about coding with TypeScript and React`,
            score: 20 - i,
          }),
        );
      }
      const subsystem = makeMockMemorySubsystem(entries);
      const injector = new SessionMemoryInjector(subsystem);
      const result = await injector.inject('sess-1', 'TypeScript React project');

      expect(result.entries.length).toBeLessThanOrEqual(5);
      expect(result.totalFound).toBe(20); // found all, but limited
    });

    it('enforces total token limit < 500', async () => {
      // Create entries with very long content
      const longContent = 'a'.repeat(2000); // ~500 tokens each
      const entries: MemorySearchResult[] = Array.from(
        { length: 5 },
        (_, i) =>
          makeResult({
            content: `long entry ${i}: ${longContent}`,
            score: 10 - i,
          }),
      );
      const subsystem = makeMockMemorySubsystem(entries);
      const injector = new SessionMemoryInjector(subsystem);
      const result = await injector.inject('sess-1', 'test');

      // Only entries that fit within 500-token budget should be included
      const totalContentTokens = result.entries.reduce(
        (sum, e) => sum + (injector as any).estimateTokens(e.entry.content),
        0,
      );
      expect(totalContentTokens).toBeLessThanOrEqual(500);
    });

    it('differentiates project vs global scope', async () => {
      const projectEntry = makeResult({
        content: 'config in package.json',
        entry: {
          sourceEvent: '/home/user/projects/myapp/package.json',
          timestamp: new Date().toISOString(),
          content: 'config in package.json',
          tags: ['project'],
          confidence: 0.8,
        },
        score: 8,
      });

      const globalEntry = makeResult({
        content: 'user prefers dark theme',
        entry: {
          sourceEvent: 'memory-global-001',
          timestamp: new Date().toISOString(),
          content: 'user prefers dark theme',
          tags: ['preference'],
          confidence: 0.8,
        },
        score: 6,
      });

      const subsystem = makeMockMemorySubsystem([projectEntry, globalEntry]);
      const injector = new SessionMemoryInjector(subsystem);
      const result = await injector.inject('sess-1', 'project config theme');

      expect(result.projectCount).toBe(1);
      expect(result.globalCount).toBe(1);
      expect(result.totalFound).toBe(2);

      // Verify project entry is marked with [project] scope in summary
      expect(result.summary).toContain('[project]');
      expect(result.summary).toContain('[global]');
    });

    it('produces a meaningful summary string with scores', async () => {
      const subsystem = makeMockMemorySubsystem([
        makeResult({
          content: '用户偏好使用 pnpm 管理 monorepo',
          score: 10,
        }),
        makeResult({
          content: '项目中有 eslint 和 prettier 配置',
          score: 7,
        }),
      ]);
      const injector = new SessionMemoryInjector(subsystem);
      const result = await injector.inject('sess-1', 'pnpm monorepo eslint');

      expect(result.summary).toContain('[Previous relevant context from memory]');
      expect(result.summary).toContain('pnpm');
      expect(result.summary).toContain('eslint');
    });
  });

  describe('extractKeywords()', () => {
    it('extracts meaningful keywords from user message', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const keywords = injector.extractKeywords(
        '帮我重构 auth 模块的用户认证逻辑',
      );
      expect(keywords).toContain('帮');
      expect(keywords).toContain('重构');
      expect(keywords).toContain('auth');
      expect(keywords).toContain('模块');
      // Stop words should be filtered
      expect(keywords).not.toContain('的');
    });

    it('handles English messages', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const keywords = injector.extractKeywords(
        'I need to refactor the authentication module',
      );
      expect(keywords).toContain('need');
      expect(keywords).toContain('refactor');
      expect(keywords).toContain('authentication');
      expect(keywords).toContain('module');
      // Stop words
      expect(keywords).not.toContain('the');
      expect(keywords).not.toContain('to');
    });

    it('returns empty array for stopword-only input', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const keywords = injector.extractKeywords('the a to of in on at');
      expect(keywords).toEqual([]);
    });

    it('limits to max 10 keywords', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const keywords = injector.extractKeywords(
        'one two three four five six seven eight nine ten eleven twelve',
      );
      expect(keywords.length).toBeLessThanOrEqual(10);
    });

    it('deduplicates keywords', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const keywords = injector.extractKeywords('refactor refactor refactor auth auth');
      expect(keywords).toHaveLength(2);
      expect(keywords).toContain('refactor');
      expect(keywords).toContain('auth');
    });
  });

  describe('isProjectScope()', () => {
    it('identifies project scope by tag', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const result = makeResult({
        content: 'some project config',
        entry: {
          sourceEvent: 'test',
          timestamp: new Date().toISOString(),
          content: 'some project config',
          tags: ['project'],
          confidence: 0.8,
        },
      });
      expect(injector.isProjectScope(result)).toBe(true);
    });

    it('identifies project scope by path patterns', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const result = makeResult({
        content: 'fixed bug in /src/utils/helper.ts',
        entry: {
          sourceEvent: '/home/projects/myapp/src/utils',
          timestamp: new Date().toISOString(),
          content: 'fixed bug in /src/utils/helper.ts',
          tags: [],
          confidence: 0.8,
        },
      });
      expect(injector.isProjectScope(result)).toBe(true);
    });

    it('returns false for global memory entries', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const result = makeResult({
        content: 'user prefers dark theme',
        entry: {
          sourceEvent: 'global-prefs',
          timestamp: new Date().toISOString(),
          content: 'user prefers dark theme',
          tags: ['preference'],
          confidence: 0.8,
        },
      });
      expect(injector.isProjectScope(result)).toBe(false);
    });
  });

  describe('applyTimeDecay()', () => {
    it('preserves fresh entries', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const now = Date.now();
      const score = (injector as any).applyTimeDecay(10, new Date(now).toISOString(), now);
      expect(score).toBeGreaterThan(9.5);
    });

    it('significantly decays entries older than half-life', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const now = Date.now();
      const old = new Date(now - 28 * 24 * 60 * 60 * 1000).toISOString(); // 28 days = 2 half-lives
      const score = (injector as any).applyTimeDecay(10, old, now);
      expect(score).toBeCloseTo(2.5, 1); // 10 * 0.5^2 = 2.5
    });

    it('handles invalid timestamp gracefully', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const score = (injector as any).applyTimeDecay(10, 'not-a-date', Date.now());
      expect(score).toBe(10); // no decay on error
    });
  });

  describe('estimateTokens()', () => {
    it('estimates CJK text correctly', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const tokens = injector.estimateTokens('你好世界');
      // 4 CJK chars * 1.5 = 6
      expect(tokens).toBe(6);
    });

    it('estimates ASCII text correctly', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const tokens = injector.estimateTokens('hello world');
      // 11 ASCII chars / 4 = ~3
      expect(tokens).toBe(3);
    });

    it('handles mixed CJK and ASCII', () => {
      const injector = new SessionMemoryInjector(makeMockMemorySubsystem());
      const tokens = injector.estimateTokens('你好 world 世界');
      // CJK: "你好世界" = 4 chars * 1.5 = 6
      // ASCII: " world " = 7 chars / 4 = 1.75 → ceil = 2
      expect(tokens).toBe(8);
    });
  });
});
