/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { askWindowCloseChoice } from './window-close-policy.js';

describe('window close policy', () => {
  it.each([
    [0, 'continue-background'],
    [1, 'stop-and-quit'],
    [2, 'cancel'],
  ] as const)('maps response %s to %s', async (response, expected) => {
    const showMessageBox = vi.fn(async () => ({ response }));
    await expect(askWindowCloseChoice({ showMessageBox })).resolves.toBe(expected);
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: ['继续后台运行', '停止任务并退出', '取消'],
      defaultId: 2,
      cancelId: 2,
    }));
  });
});
