/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startVisiblePolling, type PollingVisibilitySource } from './visiblePolling.js';

class FakeVisibilitySource implements PollingVisibilitySource {
  visibilityState: DocumentVisibilityState = 'visible';

  private readonly listeners = new Set<() => void>();

  addEventListener(type: 'visibilitychange', listener: () => void): void {
    if (type === 'visibilitychange') this.listeners.add(listener);
  }

  removeEventListener(type: 'visibilitychange', listener: () => void): void {
    if (type === 'visibilitychange') this.listeners.delete(listener);
  }

  setVisibility(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    for (const listener of this.listeners) listener();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('startVisiblePolling', () => {
  it('does not poll while hidden and refreshes immediately after becoming visible', async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibilitySource();
    visibility.setVisibility('hidden');
    const poll = vi.fn(async () => undefined);

    const stop = startVisiblePolling(poll, 5_000, { visibility });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(poll).not.toHaveBeenCalled();

    visibility.setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledOnce();

    visibility.setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledOnce();
    stop();
  });

  it('runs immediately when already visible and then follows the interval', async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibilitySource();
    const poll = vi.fn(async () => undefined);

    const stop = startVisiblePolling(poll, 5_000, { visibility });
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
  });

  it('does not overlap a slow poll', async () => {
    vi.useFakeTimers();
    const visibility = new FakeVisibilitySource();
    let resolveFirst: (() => void) | undefined;
    const poll = vi.fn(() => new Promise<void>((resolve) => {
      resolveFirst = resolve;
    }));

    const stop = startVisiblePolling(poll, 1_000, { visibility });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledOnce();

    resolveFirst?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
  });
});
