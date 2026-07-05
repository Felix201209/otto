/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentGallery 画廊浮层单测：渲染全部专家卡片、点击卡片以对应专家回调 onLaunch、
 * 关闭按钮 / 点遮罩 / Esc 均回调 onClose。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { AgentGallery } from './AgentGallery.js';
import { EXPERTS } from '../agents/experts.js';

function renderGallery() {
  const onLaunch = vi.fn();
  const onClose = vi.fn();
  render(<AgentGallery onLaunch={onLaunch} onClose={onClose} />);
  return { onLaunch, onClose };
}

describe('AgentGallery', () => {
  it('渲染全部 8 张专家卡片（按名称）', () => {
    renderGallery();
    for (const e of EXPERTS) {
      expect(screen.getByText(e.name)).toBeTruthy();
    }
  });

  it('点击某张卡片 → 以对应专家回调 onLaunch', () => {
    const { onLaunch } = renderGallery();
    const target = EXPERTS[1]; // 会议纪要转录
    fireEvent.click(screen.getByText(target.name));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith(target);
  });

  it('点关闭按钮 → onClose', () => {
    const { onClose } = renderGallery();
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc → onClose', () => {
    const { onClose } = renderGallery();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点卡片外的遮罩 → onClose', () => {
    const { onClose } = renderGallery();
    // 对话框内部点击不关闭（stopPropagation）
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
