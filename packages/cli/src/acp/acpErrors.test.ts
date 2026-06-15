/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { getAcpErrorMessage } from './acpErrors.js';

describe('getAcpErrorMessage', () => {
  it('returns the plain message for Error instances', () => {
    expect(getAcpErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns the string for primitive error values', () => {
    expect(getAcpErrorMessage('oops')).toBe('oops');
  });

  it('unwraps a nested Google API-style JSON error', () => {
    const nested = JSON.stringify({
      error: { code: 400, message: 'Invalid argument' },
    });
    expect(getAcpErrorMessage(new Error(nested))).toBe('Invalid argument');
  });

  it('unwraps array-shaped API errors', () => {
    const nested = JSON.stringify([{ error: { message: 'Quota exceeded' } }]);
    expect(getAcpErrorMessage(new Error(nested))).toBe('Quota exceeded');
  });

  it('leaves malformed JSON alone', () => {
    expect(getAcpErrorMessage(new Error('{not-json'))).toBe('{not-json');
  });

  it('recurses when the unwrapped message is itself JSON', () => {
    const inner = JSON.stringify({ error: { message: 'real cause' } });
    const outer = JSON.stringify({ error: { message: inner } });
    expect(getAcpErrorMessage(new Error(outer))).toBe('real cause');
  });
});
