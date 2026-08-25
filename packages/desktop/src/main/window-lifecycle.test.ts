/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_WINDOW_LIFECYCLE_CHANNEL,
  observeDesktopWindowActivity,
  resumeDesktopWindow,
  suspendDesktopWindow,
} from './window-lifecycle.js';

describe('desktop window lifecycle', () => {
  it('关闭窗口时先通知 preload 暂停连接，再隐藏窗口', () => {
    const calls: string[] = [];
    const window = {
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, action: string) => {
          calls.push(`send:${channel}:${action}`);
        },
      },
      hide: () => calls.push('hide'),
    };

    expect(suspendDesktopWindow(window)).toBe(true);
    expect(calls).toEqual([
      `send:${DESKTOP_WINDOW_LIFECYCLE_CHANNEL}:suspend`,
      'hide',
    ]);
  });

  it('重新打开已有窗口时通知 preload 恢复连接', () => {
    const send = vi.fn();
    const window = {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
      hide: vi.fn(),
    };

    expect(resumeDesktopWindow(window)).toBe(true);
    expect(send).toHaveBeenCalledWith(
      DESKTOP_WINDOW_LIFECYCLE_CHANNEL,
      'resume',
    );
    expect(window.hide).not.toHaveBeenCalled();
  });

  it('销毁中的窗口不再发送生命周期事件', () => {
    const send = vi.fn();
    const window = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false, send },
      hide: vi.fn(),
    };

    expect(suspendDesktopWindow(window)).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
  });
  it('tracks hidden, minimized, restored, and closing windows through one foreground signal', () => {
    let visible = false;
    let minimized = false;
    const listeners = new Map<string, Set<() => void>>();
    const window = {
      isVisible: () => visible,
      isMinimized: () => minimized,
      on(event: string, listener: () => void) {
        const registered = listeners.get(event) ?? new Set<() => void>();
        registered.add(listener);
        listeners.set(event, registered);
        return window;
      },
      removeListener(event: string, listener: () => void) {
        listeners.get(event)?.delete(listener);
        return window;
      },
    };
    const emit = (event: string): void => {
      for (const listener of listeners.get(event) ?? []) listener();
    };
    const foregroundStates: boolean[] = [];

    const stop = observeDesktopWindowActivity(
      window,
      (foreground) => foregroundStates.push(foreground),
    );
    expect(foregroundStates).toEqual([false]);

    visible = true;
    emit('show');
    minimized = true;
    emit('minimize');
    minimized = false;
    emit('restore');
    emit('close');
    expect(foregroundStates).toEqual([false, true, false, true, false]);

    stop();
    emit('show');
    expect(foregroundStates).toEqual([false, true, false, true, false]);
  });


});
