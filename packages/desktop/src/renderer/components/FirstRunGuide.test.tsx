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
  it('walks through the conversational UI and remembers completion for that mode', () => {
    render(<FirstRunGuide mode="conversational" />);

    expect(screen.getByText('对话就是主工作区')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('从这里发起任务')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('历史与企业入口都在左侧')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '开始使用' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(localStorage.getItem('otto:first-run-guide:v2:conversational')).toBe('completed');
    expect(localStorage.getItem('otto:first-run-guide:v2:work')).toBeNull();
  });

  it('uses a separate walkthrough and completion state for the work UI', () => {
    localStorage.setItem('otto:first-run-guide:v2:conversational', 'completed');
    render(<FirstRunGuide mode="work" />);

    expect(screen.getByText('对话与工作区并排协作')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('右侧工作区会一直陪着你')).toBeTruthy();
    expect(screen.getByText('工作式 UI 导览')).toBeTruthy();
  });

  it('starts the matching walkthrough when the user switches UI modes', () => {
    localStorage.setItem('otto:first-run-guide:v2:conversational', 'completed');
    const view = render(<FirstRunGuide mode="conversational" />);
    expect(screen.queryByRole('dialog')).toBeNull();

    view.rerender(<FirstRunGuide mode="work" />);
    expect(screen.getByText('对话与工作区并排协作')).toBeTruthy();
  });

  it('stays hidden after the selected mode has completed its walkthrough', () => {
    localStorage.setItem('otto:first-run-guide:v2:work', 'completed');
    render(<FirstRunGuide mode="work" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('supports direct step navigation from the progress controls', () => {
    render(<FirstRunGuide mode="conversational" />);
    fireEvent.click(screen.getByRole('button', { name: /前往第 3 步/ }));
    expect(screen.getByText('历史与企业入口都在左侧')).toBeTruthy();
  });

  it('remains usable when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    render(<FirstRunGuide mode="conversational" />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '跳过导览' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
