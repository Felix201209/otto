/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { formatElapsed } from './GoalActiveIndicator.js';

describe('formatElapsed', () => {
  it('renders sub-minute durations as plain "Ns"', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s'); // <1s rounds down
    expect(formatElapsed(1_000)).toBe('1s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('renders sub-hour durations as "Mm Ss"', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s');
    // 12 minutes 34 seconds
    expect(formatElapsed(12 * 60_000 + 34_000)).toBe('12m 34s');
    // exactly 59m 59s — boundary just before the hour switchover
    expect(formatElapsed(59 * 60_000 + 59_000)).toBe('59m 59s');
  });

  it('renders hour-or-more durations as "Hh Mm" (drops seconds)', () => {
    // exactly 1h
    expect(formatElapsed(60 * 60_000)).toBe('1h 0m');
    // 2h 13m 27s — seconds intentionally not shown beyond the hour mark
    // (status-bar real estate is tight, and per-second precision stops
    // mattering once you're hours into a goal)
    expect(formatElapsed(2 * 60 * 60_000 + 13 * 60_000 + 27_000)).toBe('2h 13m');
    // 25h+ (long-running tasks during multi-day work)
    expect(formatElapsed(25 * 60 * 60_000 + 5 * 60_000)).toBe('25h 5m');
  });

  it('clamps negative input to "0s" (clock skew, system time set backwards)', () => {
    // Without the clamp this would render "-3s" and look broken.
    expect(formatElapsed(-3_000)).toBe('0s');
    expect(formatElapsed(-1)).toBe('0s');
  });

  it('handles fractional milliseconds by flooring to the lower second', () => {
    // 1500ms = 1.5s → "1s" (we never round up, to avoid showing a value
    // that's larger than the real elapsed time).
    expect(formatElapsed(1_500)).toBe('1s');
    expect(formatElapsed(59_500)).toBe('59s');
  });
});
