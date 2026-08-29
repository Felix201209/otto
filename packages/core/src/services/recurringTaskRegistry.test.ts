/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecurringTaskRegistry } from './recurringTaskRegistry.js';

afterEach(() => vi.useRealTimers());

describe('RecurringTaskRegistry', () => {
  it('records ownership, cadence, cost and a stop function', () => {
    const registry = new RecurringTaskRegistry();
    registry.register({
      name: 'local-index', source: 'test', intervalMs: 60_000,
      estimatedCostUsdPerRun: 0, getInputVersion: () => 'v1', run: vi.fn(),
    });

    expect(registry.list()).toMatchObject([{
      name: 'local-index', source: 'test', intervalMs: 60_000,
      estimatedCostUsdPerRun: 0, paid: false, inputVersion: 'v1',
      stop: expect.any(Function),
    }]);
    registry.stopAll();
  });

  it('keeps paid background work disabled unless explicitly enabled', () => {
    const registry = new RecurringTaskRegistry();
    const stop = registry.register({
      name: 'model-analysis', source: 'test', intervalMs: 1_000,
      estimatedCostUsdPerRun: 0.01, getInputVersion: () => 'v1', run: vi.fn(),
    });

    expect(stop).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it('does not rerun unchanged input and never overlaps executions', async () => {
    vi.useFakeTimers();
    let version = 'v1';
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const registry = new RecurringTaskRegistry({ allowPaidBackground: true });
    registry.register({
      name: 'analysis', source: 'test', intervalMs: 1_000,
      estimatedCostUsdPerRun: 0.01, getInputVersion: () => version, run,
    });

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(run).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5_000);
    expect(run).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
    version = 'v2';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    registry.stopAll();
  });
});
