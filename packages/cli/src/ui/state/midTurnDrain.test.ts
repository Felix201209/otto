/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { computeMidTurnDrain } from './midTurnDrain.js';

describe('computeMidTurnDrain', () => {
  it('drains the full queue when not paused and not in edit mode', () => {
    const r = computeMidTurnDrain(['a', 'b', 'c'], false, false);
    expect(r.drained).toEqual(['a', 'b', 'c']);
    expect(r.nextQueue).toEqual([]);
  });

  it('drains nothing when the queue is empty', () => {
    const r = computeMidTurnDrain([], false, false);
    expect(r.drained).toEqual([]);
    expect(r.nextQueue).toEqual([]);
  });

  it('drains nothing when paused — queue preserved as-is', () => {
    const r = computeMidTurnDrain(['a', 'b'], true, false);
    expect(r.drained).toEqual([]);
    expect(r.nextQueue).toEqual(['a', 'b']);
  });

  it('drains nothing in edit mode — queue preserved as-is', () => {
    const r = computeMidTurnDrain(['a', 'b'], false, true);
    expect(r.drained).toEqual([]);
    expect(r.nextQueue).toEqual(['a', 'b']);
  });

  it('preserves FIFO order in the drained list', () => {
    const r = computeMidTurnDrain(['first', 'second', 'third'], false, false);
    expect(r.drained).toEqual(['first', 'second', 'third']);
  });

  it('returns a copy of the queue, not the original reference (caller-mutation safe)', () => {
    const original = ['x', 'y'];
    const r = computeMidTurnDrain(original, false, false);
    // Mutating the returned drained array must not change the caller's queue ref.
    r.drained.push('mutated');
    expect(original).toEqual(['x', 'y']);
  });
});
