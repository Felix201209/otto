/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentGallery 页面单测：渲染全部专家卡片、点击卡片以对应专家回调 onLaunch、
 * 「返回对话」按钮 / Esc 均回调 onBack（页面化后不再有遮罩/关闭弹窗语义）。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { AgentGallery } from './AgentGallery.js';
import { EXPERTS } from '../agents/experts.js';

function renderGallery() {
  const onLaunch = vi.fn();
  const onBack = vi.fn();
  render(<AgentGallery onLaunch={onLaunch} onBack={onBack} />);
  return { onLaunch, onBack };
}

describe('AgentGallery（页面）', () => {
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

  it('点「返回对话」→ onBack', () => {
    const { onBack } = renderGallery();
    fireEvent.click(screen.getByRole('button', { name: '返回对话' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('Esc → onBack', () => {
    const { onBack } = renderGallery();
    fireEvent.keyDown(screen.getByRole('region', { name: '智能体 · 企业专家' }), {
      key: 'Escape',
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
