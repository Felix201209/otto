/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ConfirmDialog 单测：open 开关、确认 / 取消回调、点遮罩取消、Esc 取消、
 * Enter 确认、默认焦点落取消钮、Tab 焦点陷阱、danger 决定确认钮红色、
 * 无障碍属性（role/aria-modal/labelledby/describedby）。
 */

import type React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog.js';

function renderDialog(over: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open
      title="删除对话"
      message="确定删除「测试对话」吗？此操作不可撤销。"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...over}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog：渲染与开关', () => {
  it('open=false 时不渲染任何内容', () => {
    render(
      <ConfirmDialog
        open={false}
        title="删除对话"
        message="msg"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('open=true 渲染标题 / 正文 / 默认按钮文案', () => {
    renderDialog();
    expect(screen.getByText('删除对话')).toBeTruthy();
    expect(
      screen.getByText('确定删除「测试对话」吗？此操作不可撤销。'),
    ).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();
    expect(screen.getByText('取消')).toBeTruthy();
  });

  it('confirmText / cancelText 覆盖默认文案', () => {
    renderDialog({ confirmText: '清空', cancelText: '算了' });
    expect(screen.getByText('清空')).toBeTruthy();
    expect(screen.getByText('算了')).toBeTruthy();
  });
});

describe('ConfirmDialog：确认 / 取消回调', () => {
  it('点「删除」触发 onConfirm，不触发 onCancel', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByText('删除'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('点「取消」触发 onCancel，不触发 onConfirm', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByText('取消'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('点遮罩（起手落在遮罩本身）触发 onCancel', () => {
    const { onCancel } = renderDialog();
    const overlay = document.querySelector('.otto-confirm-overlay') as HTMLElement;
    // mouseDown target === overlay 自身 → 取消。
    fireEvent.mouseDown(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('点卡片内部不触发 onCancel（stopPropagation）', () => {
    const { onCancel } = renderDialog();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog：键盘', () => {
  it('Esc 触发 onCancel', () => {
    const { onCancel } = renderDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Enter 触发 onConfirm', () => {
    const { onConfirm } = renderDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Tab 在两钮间循环（焦点陷阱）', () => {
    renderDialog();
    const cancel = screen.getByText('取消');
    const confirm = screen.getByText('删除');
    // 打开默认焦点在取消钮。
    expect(document.activeElement).toBe(cancel);
    // Tab → 移到确认钮。
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(confirm);
    // 再 Tab → 循环回取消钮。
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
  });
});

describe('ConfirmDialog：焦点与无障碍', () => {
  it('打开时焦点默认落「取消」按钮（防误删）', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByText('取消'));
  });

  it('dialog 带 role / aria-modal / labelledby / describedby', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelId = dialog.getAttribute('aria-labelledby');
    const descId = dialog.getAttribute('aria-describedby');
    expect(labelId).toBeTruthy();
    expect(descId).toBeTruthy();
    // 关联的确实是标题 / 正文节点。
    expect(document.getElementById(labelId!)?.textContent).toBe('删除对话');
    expect(document.getElementById(descId!)?.textContent).toBe(
      '确定删除「测试对话」吗？此操作不可撤销。',
    );
  });
});

describe('ConfirmDialog：danger 样式', () => {
  it('danger 默认 true → 确认钮带 --danger 修饰类', () => {
    renderDialog();
    expect(
      screen.getByText('删除').classList.contains('otto-confirm__confirm--danger'),
    ).toBe(true);
  });

  it('danger=false → 确认钮不带 --danger 修饰类', () => {
    renderDialog({ danger: false });
    expect(
      screen.getByText('删除').classList.contains('otto-confirm__confirm--danger'),
    ).toBe(false);
  });
});
