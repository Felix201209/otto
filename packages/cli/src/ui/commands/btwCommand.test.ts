/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for both:
 *   1. The `btwCommand` slash-command entry (CLI registration / immediate flag)
 *   2. `parseBtwCommand` used by Feishu mode to detect the prefix
 */

import { describe, it, expect } from 'vitest';
import { btwCommand } from './btwCommand.js';
import { parseBtwCommand } from './feishuCommand.js';

describe('btwCommand (slash command registration)', () => {
  it('has the right name and immediate flag', () => {
    expect(btwCommand.name).toBe('btw');
    expect(btwCommand.immediate).toBe(true);
  });

  it('action returns a usage-hint message (no model call)', async () => {
    const result = await btwCommand.action?.({} as never, '');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    expect(JSON.stringify(result)).toMatch(/btw/i);
  });
});

describe('parseBtwCommand (Feishu prefix detection)', () => {
  it.each([
    ['/btw how much does the cache hit?', 'how much does the cache hit?'],
    ['/BTW Mixed Case', 'Mixed Case'],
    ['/btw  multi  spaces  ', 'multi  spaces'],
    ['/btw 中文问题', '中文问题'],
  ])('matches %j → question=%j', (input, expected) => {
    expect(parseBtwCommand(input)).toBe(expected);
  });

  it('returns "" (matched but empty) for bare `/btw` with no args', () => {
    expect(parseBtwCommand('/btw')).toBe('');
    expect(parseBtwCommand('/btw  ')).toBe('');
  });

  it('returns null for non-matches', () => {
    expect(parseBtwCommand('/btweird stuff')).toBeNull();
    expect(parseBtwCommand('btw no leading slash')).toBeNull();
    expect(parseBtwCommand('  /btw with leading whitespace')).toBeNull();
    expect(parseBtwCommand('/help')).toBeNull();
    expect(parseBtwCommand('')).toBeNull();
  });

  it('captures multi-line questions in full', () => {
    const q = parseBtwCommand('/btw line one\nline two\nline three');
    expect(q).toBe('line one\nline two\nline three');
  });
});
