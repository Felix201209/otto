/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { localDateKey } from './localDateKey.js';

describe('localDateKey', () => {
  it('uses local calendar fields instead of the UTC ISO date', () => {
    const localMidnight = {
      getFullYear: () => 2026,
      getMonth: () => 8,
      getDate: () => 1,
      toISOString: () => '2026-08-31T16:30:00.000Z',
    } as Date;

    expect(localDateKey(localMidnight)).toBe('2026-09-01');
  });
});
