/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { extractUserVisibleModelResponseText } from './client.js';

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
