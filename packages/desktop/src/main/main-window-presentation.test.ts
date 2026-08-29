/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { MainWindowPresentationController } from './main-window-presentation.js';

function createTarget(options?: { minimized?: boolean; destroyed?: boolean }) {
  let minimized = options?.minimized ?? false;
  return {
    target: {
      isDestroyed: vi.fn(() => options?.destroyed ?? false),
      isMinimized: vi.fn(() => minimized),
      restore: vi.fn(() => {
        minimized = false;
      }),
      show: vi.fn(),
      focus: vi.fn(),
    },
  };
}

describe('MainWindowPresentationController', () => {
  it('queues a focus request until the renderer is ready', () => {
    const { target } = createTarget();
    const controller = new MainWindowPresentationController(target);

    controller.requestShow({ focus: true });

    expect(target.show).not.toHaveBeenCalled();
    expect(target.focus).not.toHaveBeenCalled();

    controller.markReady();

    expect(target.show).toHaveBeenCalledTimes(1);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it('reveals the initial window without stealing focus when content finishes loading', () => {
    const { target } = createTarget();
    const controller = new MainWindowPresentationController(target);

    controller.markReady();

    expect(target.show).toHaveBeenCalledTimes(1);
    expect(target.focus).not.toHaveBeenCalled();
  });

  it('does not reveal twice when both readiness signals fire', () => {
    const { target } = createTarget();
    const controller = new MainWindowPresentationController(target);

    controller.markReady();
    controller.markReady();

    expect(target.show).toHaveBeenCalledTimes(1);
  });

  it('restores a minimized ready window before showing and focusing it', () => {
    const { target } = createTarget({ minimized: true });
    const controller = new MainWindowPresentationController(target);
    controller.markReady();
    target.show.mockClear();

    controller.requestShow({ focus: true });

    expect(target.restore).toHaveBeenCalledTimes(1);
    expect(target.show).toHaveBeenCalledTimes(1);
    expect(target.focus).toHaveBeenCalledTimes(1);
  });

  it('does not act on a destroyed window', () => {
    const { target } = createTarget({ destroyed: true });
    const controller = new MainWindowPresentationController(target);

    controller.markReady();
    controller.requestShow({ focus: true });

    expect(target.restore).not.toHaveBeenCalled();
    expect(target.show).not.toHaveBeenCalled();
    expect(target.focus).not.toHaveBeenCalled();
  });
});
