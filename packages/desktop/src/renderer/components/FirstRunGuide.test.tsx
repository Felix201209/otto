/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirstRunGuide } from './FirstRunGuide.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('FirstRunGuide', () => {
  it('walks a new user through identity, messages and E2EE, then remembers completion', () => {
    render(<FirstRunGuide />);

    expect(screen.getByText('欢迎使用 Otto')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('统一消息中心')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('端到端加密与设备安全')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '完成导览' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem('otto:first-run-guide:v1')).toBe('completed');
  });

  it('stays hidden after completion', () => {
    localStorage.setItem('otto:first-run-guide:v1', 'completed');
    render(<FirstRunGuide />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('remains usable when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    render(<FirstRunGuide />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '跳过导览' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
