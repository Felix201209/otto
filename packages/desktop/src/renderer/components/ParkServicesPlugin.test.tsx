/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ParkServicesPlugin 单测：入口卡片渲染、点击展开对话框、六项服务齐全、
 * 点服务 = 派发 composer 注入事件 + 关闭、Esc / 遮罩 / × 关闭、无障碍属性。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import { ParkServicesPlugin } from './ParkServicesPlugin.js';

afterEach(cleanup);

/** 监听 Composer 注入事件（insertComposerDraft 派发的 CustomEvent）。 */
function listenDraft(): { texts: string[]; stop: () => void } {
  const texts: string[] = [];
  const handler = (e: Event): void => {
    texts.push((e as CustomEvent<string>).detail);
  };
  window.addEventListener('otto:composer-insert', handler);
  return { texts, stop: () => window.removeEventListener('otto:composer-insert', handler) };
}

describe('ParkServicesPlugin', () => {
  it('默认只渲染入口卡片，不渲染对话框', () => {
    render(<ParkServicesPlugin />);
    expect(screen.getByTitle('宏创AI园区服务')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('点击卡片展开居中对话框，六项服务齐全', () => {
    render(<ParkServicesPlugin />);
    fireEvent.click(screen.getByTitle('宏创AI园区服务'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    for (const name of ['访客邀约', '会议室预订', 'IT 报修', '行政后勤', '班车通勤', '餐饮服务']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it('点服务项：派发 composer 注入事件（含服务模板）并关闭对话框', () => {
    const l = listenDraft();
    render(<ParkServicesPlugin />);
    fireEvent.click(screen.getByTitle('宏创AI园区服务'));
    fireEvent.click(screen.getByText('会议室预订'));
    expect(l.texts).toHaveLength(1);
    expect(l.texts[0]).toContain('宏创园区会议室');
    expect(screen.queryByRole('dialog')).toBeNull();
    l.stop();
  });

  it('Esc / 点遮罩 / 右上 × 都能关闭', () => {
    render(<ParkServicesPlugin />);
    const openCard = (): void => {
      fireEvent.click(screen.getByTitle('宏创AI园区服务'));
    };

    openCard();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    openCard();
    const overlay = document.querySelector('.otto-park-overlay')!;
    fireEvent.mouseDown(overlay);
    expect(screen.queryByRole('dialog')).toBeNull();

    openCard();
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('无障碍：dialog 具备 aria-modal 且由标题 labelledby', () => {
    render(<ParkServicesPlugin />);
    fireEvent.click(screen.getByTitle('宏创AI园区服务'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBe('宏创AI园区服务');
  });

  it('企业定制：parkConfig 的 brandName/services 覆盖内置默认', async () => {
    const otto = {
      parkConfig: () =>
        Promise.resolve({
          brandName: '星火智慧园区服务',
          services: [{ name: '自定义服务A', desc: '描述A', prompt: '模板A' }],
        }),
    };
    (window as unknown as { otto: typeof otto }).otto = otto;
    try {
      render(<ParkServicesPlugin />);
      // 配置异步生效：标题与服务清单都换成企业定制。
      fireEvent.click(await screen.findByTitle('星火智慧园区服务'));
      expect(screen.getByText('自定义服务A')).toBeTruthy();
      expect(screen.queryByText('访客邀约')).toBeNull();
    } finally {
      delete (window as unknown as { otto?: typeof otto }).otto;
    }
  });

  it('企业定制：只给 parkName 时六项默认服务换园区称呼', async () => {
    const otto = {
      parkConfig: () => Promise.resolve({ parkName: '星火园区' }),
    };
    (window as unknown as { otto: typeof otto }).otto = otto;
    try {
      const l = listenDraft();
      render(<ParkServicesPlugin />);
      fireEvent.click(screen.getByTitle('宏创AI园区服务'));
      // 等配置生效后再点（模板已换名）。
      await screen.findByText('会议室预订');
      fireEvent.click(screen.getByText('会议室预订'));
      // setState 是异步微任务，等注入事件到达。
      await new Promise((r) => setTimeout(r, 0));
      expect(l.texts[0]).toContain('星火园区会议室');
      l.stop();
    } finally {
      delete (window as unknown as { otto?: typeof otto }).otto;
    }
  });
});
