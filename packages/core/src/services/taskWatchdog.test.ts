/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskWatchdog } from './taskWatchdog.js';

afterEach(() => vi.useRealTimers());

describe('TaskWatchdog', () => {
  it('emits one stall snapshot and heartbeat postpones the deadline', async () => {
    vi.useFakeTimers();
    const onStall = vi.fn(async () => undefined);
    const watchdog = new TaskWatchdog({
      timeoutMs: 1_000,
      checkIntervalMs: 100,
      onStall,
    });

    watchdog.start({ sessionId: 's1', promptId: 'p1' });
    await vi.advanceTimersByTimeAsync(700);
    watchdog.touch('stream');
    await vi.advanceTimersByTimeAsync(700);
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(onStall).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onStall).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });
});
