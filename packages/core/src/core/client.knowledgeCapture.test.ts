/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildAutomaticKnowledgeContext,
  extractUserVisibleModelResponseText,
} from './client.js';

describe('extractUserVisibleModelResponseText', () => {
  it('captures only final user-visible text and excludes hidden thoughts', () => {
    const text = extractUserVisibleModelResponseText([
      {
        text: 'SDK aggregate that may include internal text',
        candidates: [
          {
            content: {
              parts: [
                {
                  thought: true,
                  text: 'private chain of thought',
                  thoughtSignature: 'secret-signature',
                },
                { text: '已完成修复并通过测试。' },
                { functionCall: { name: 'shell', args: {} } },
              ],
            },
          },
        ],
      },
    ]);

    expect(text).toBe('已完成修复并通过测试。');
    expect(text).not.toContain('private chain of thought');
    expect(text).not.toContain('SDK aggregate');
  });

  it('uses a top-level text fallback only when no candidate parts exist', () => {
    expect(
      extractUserVisibleModelResponseText([{ text: 'visible fallback' }]),
    ).toBe('visible fallback');
    expect(
      extractUserVisibleModelResponseText([{ text: 'hidden', thought: true }]),
    ).toBe('');
  });
});

describe('buildAutomaticKnowledgeContext', () => {
  it('recalls a bounded set without exposing storage ids', async () => {
    const context = await buildAutomaticKnowledgeContext(
      '后台模型费用',
      {
        search: async () => [{
          id: 'kb_secret_internal_id',
          category: 'decision',
          content: '后台模型任务默认关闭，只有用户明确开启后才能运行。',
          tags: ['成本'],
          createdAt: '2026-08-27T00:00:00.000Z',
          score: 50,
          strength: 0.92,
          freshness: 'current',
        }],
      },
    );

    expect(context?.text).toContain('后台模型任务默认关闭');
    expect(context?.text).toContain('strength 92%');
    expect(context?.text).not.toContain('kb_secret_internal_id');
    expect(context?.entries).toHaveLength(1);
  });

  it('does not search for empty or trivial input', async () => {
    let searched = false;
    await expect(buildAutomaticKnowledgeContext('  ', {
      search: async () => {
        searched = true;
        return [];
      },
    })).resolves.toBeNull();
    expect(searched).toBe(false);
  });
});
