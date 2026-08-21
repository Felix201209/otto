/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_WINDOW_LIFECYCLE_CHANNEL,
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


});
