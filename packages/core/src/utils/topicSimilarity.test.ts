/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { textSimilarity, findMostSimilarTopic, DEFAULT_MERGE_THRESHOLD } from './topicSimilarity.js';

describe('textSimilarity', () => {
  it('returns 1 for identical text', () => {
    expect(textSimilarity('合同审查流程优化', '合同审查流程优化')).toBe(1);
  });

  it('returns a high score for a reworded version of the same Chinese topic (no spaces)', () => {
    // 同一件事换了个说法，中文没有空格分隔——这是本工具存在的核心场景。
    const score = textSimilarity('合同审查流程优化', '优化合同审查的流程');
    expect(score).toBeGreaterThanOrEqual(DEFAULT_MERGE_THRESHOLD);
  });

  it('returns a low score for genuinely unrelated topics', () => {
    const score = textSimilarity('合同审查流程优化', '公司年度财务报表审计');
    expect(score).toBeLessThan(DEFAULT_MERGE_THRESHOLD);
  });

  it('is case-insensitive for Latin text', () => {
    expect(textSimilarity('Refactor Auth Module', 'refactor auth module')).toBe(1);
  });

  it('returns a high score for near-duplicate English task titles', () => {
    const score = textSimilarity('Refactor the authentication module', 'Refactor auth module');
    expect(score).toBeGreaterThanOrEqual(0.4);
  });

  it('returns 0 for two empty strings (not treated as a match)', () => {
    expect(textSimilarity('', '')).toBe(0);
  });

  it('returns 0 when one side is empty', () => {
    expect(textSimilarity('something', '')).toBe(0);
  });

  it('is symmetric: sim(a,b) === sim(b,a)', () => {
    const a = '合同审查流程优化';
    const b = '优化合同审查的流程';
    expect(textSimilarity(a, b)).toBe(textSimilarity(b, a));
  });
});

describe('findMostSimilarTopic', () => {
  it('returns null (i.e. "new topic") when no candidate meets the threshold', () => {
    const result = findMostSimilarTopic('合同审查流程优化', [
      { id: 'p1', text: '公司年度财务报表审计' },
      { id: 'p2', text: '市场营销活动策划方案' },
    ]);
    expect(result).toBeNull();
  });

  it('returns the matching candidate id when a reworded duplicate topic exists', () => {
    const result = findMostSimilarTopic('优化合同审查的流程', [
      { id: 'p1', text: '公司年度财务报表审计' },
      { id: 'p2', text: '合同审查流程优化' },
    ]);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('p2');
    expect(result!.score).toBeGreaterThanOrEqual(DEFAULT_MERGE_THRESHOLD);
  });

  it('picks the single BEST match when multiple candidates exceed the threshold', () => {
    const result = findMostSimilarTopic('合同审查流程优化', [
      { id: 'close-but-not-exact', text: '审查合同的流程优化工作' },
      { id: 'exact', text: '合同审查流程优化' },
    ]);
    expect(result!.id).toBe('exact');
    expect(result!.score).toBe(1);
  });

  it('respects a custom threshold', () => {
    // With a very strict threshold, even a decent rewording should NOT match.
    const strict = findMostSimilarTopic('合同审查流程优化', [
      { id: 'p1', text: '优化合同审查的流程' },
    ], 0.99);
    expect(strict).toBeNull();

    // With a lenient threshold, it should match.
    const lenient = findMostSimilarTopic('合同审查流程优化', [
      { id: 'p1', text: '优化合同审查的流程' },
    ], 0.1);
    expect(lenient).not.toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(findMostSimilarTopic('anything', [])).toBeNull();
  });
});
