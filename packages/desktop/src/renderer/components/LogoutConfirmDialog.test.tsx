/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LogoutConfirmDialog } from './LogoutConfirmDialog.js';

describe('退出登录二次确认', () => {
  it('只有明确确认后才执行退出，取消不会触发注销', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <LogoutConfirmDialog
        open
        accountName="Felix"
        busy={false}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByRole('dialog', { name: '确认退出登录' })).toBeTruthy();
    expect(
      screen.getByText(
        '退出后需要重新登录；本机对话、模型/API 密钥、知识库和 Skill 都会保留。',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认退出' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
