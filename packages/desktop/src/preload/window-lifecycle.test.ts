/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { applyDesktopConnectionLifecycle } from './window-lifecycle.js';

describe('preload desktop connection lifecycle', () => {
  it('suspend clears pending frames and disconnects; resume reconnects', async () => {
    const disconnect = vi.fn();
    const connect = vi.fn(async () => true);
    const clearPending = vi.fn();

    await applyDesktopConnectionLifecycle('suspend', {
      disconnect,
      connect,
      clearPending,
    });
    expect(clearPending).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();

    await applyDesktopConnectionLifecycle('resume', { disconnect, connect });
    expect(connect).toHaveBeenCalledOnce();
  });
});
