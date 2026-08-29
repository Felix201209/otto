/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import {
  IDLE_EXTERNAL_ORIGINS,
  simulateFreshInstallIdle,
} from './idle-safety-simulation.js';

describe.each([24, 72] as const)('%s-hour fresh-install idle simulation', (hours) => {
  it('makes zero paid or external calls with unchanged data', () => {
    const result = simulateFreshInstallIdle(hours);
    expect(result.paidCalls).toBe(0);
    for (const origin of IDLE_EXTERNAL_ORIGINS) {
      expect(result.intercepted[origin]).toBe(0);
    }
  });

  it.each([
    'offline',
    '429',
    '5xx',
    'timeout',
    'crash-recovery',
    'missing-key',
    'disk-full',
    'reconnect',
  ] as const)('contains %s without replaying idle work', (failure) => {
    const result = simulateFreshInstallIdle(hours);
    expect(result.failures[failure]).toBe('contained');
    expect(result.paidCalls).toBe(0);
  });
});
