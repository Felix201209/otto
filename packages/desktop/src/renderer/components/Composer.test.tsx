/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Composer 模型菜单单测（搜索 / 分组）：
 *   BYO-key 用户接多个 provider 后模型列表会很长。模型数超过阈值（8）才在菜单顶部
 *   加搜索框并按 provider 分组；少量模型仍平铺、无搜索噪声。搜索按 displayName 过滤，
 *   且不破坏当前模型的勾选高亮。
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import type { ModelInfo } from 'otto-server';
import { Composer } from './Composer.js';

/** 造 n 个模型（跨两个 provider），displayName 形如「模型-01」。 */
function makeModels(n: number): ModelInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    displayName: `模型-${String(i + 1).padStart(2, '0')}`,
    provider: i % 2 === 0 ? 'anthropic' : 'openai',
  }));
}

function renderComposer(models: ModelInfo[], current: string | null) {
  render(
    <Composer
      models={models}
      currentModel={current}
      sessionId="s1"
      onSend={vi.fn()}
      onSetModel={vi.fn()}
    />,
  );
}

/** 打开模型菜单：点 model pill（可访问名取当前模型 displayName，改用 class 定位更稳）。 */
function openMenu() {
  const pill = document.querySelector('.otto-modelpill');
  fireEvent.click(pill as Element);
  return screen.getByRole('listbox', { name: '选择模型' });
}

describe('模型菜单搜索框显隐（阈值 8）', () => {
  it('模型数 ≤ 8：不显示搜索框，平铺全部', () => {
    renderComposer(makeModels(8), 'm0');
    openMenu();
    expect(screen.queryByLabelText('搜索模型')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(8);
  });

  it('模型数 > 8：显示搜索框', () => {
    renderComposer(makeModels(9), 'm0');
    openMenu();
    expect(screen.getByLabelText('搜索模型')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(9);
  });
});

describe('模型菜单搜索过滤', () => {
  it('按 displayName 过滤（大小写 / 子串匹配）', () => {
    renderComposer(makeModels(12), 'm0');
    openMenu();
    const search = screen.getByLabelText('搜索模型');
    // 「模型-01」匹配 1 项。
    fireEvent.change(search, { target: { value: '模型-01' } });
    const opts = screen.getAllByRole('option');
    expect(opts).toHaveLength(1);
    expect(opts[0].textContent).toContain('模型-01');
  });

  it('无匹配时显示「未找到」提示、无选项', () => {
    renderComposer(makeModels(12), 'm0');
    openMenu();
    fireEvent.change(screen.getByLabelText('搜索模型'), {
      target: { value: 'zzz不存在' },
    });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('未找到匹配的模型')).toBeTruthy();
  });
});

describe('每会话草稿隔离', () => {
  const ta = () =>
    document.querySelector('.otto-composer__textarea') as HTMLTextAreaElement;

  it('切换会话时各自保留未发送的草稿，切回原样复现', () => {
    const { rerender } = render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );

    // 在 s1 打一段草稿。
    fireEvent.change(ta(), { target: { value: 'draft-for-s1' } });
    expect(ta().value).toBe('draft-for-s1');

    // 切到 s2：不该串到 s1 的草稿，应是空的。
    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s2"
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );
    expect(ta().value).toBe('');

    // 在 s2 打另一段草稿。
    fireEvent.change(ta(), { target: { value: 'draft-for-s2' } });
    expect(ta().value).toBe('draft-for-s2');

    // 切回 s1：恢复 s1 自己的草稿。
    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );
    expect(ta().value).toBe('draft-for-s1');

    // 再切回 s2：恢复 s2 自己的草稿。
    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s2"
        onSend={vi.fn()}
        onSetModel={vi.fn()}
      />,
    );
    expect(ta().value).toBe('draft-for-s2');
  });

  it('发送后清空，切走再切回不残留已发送内容', () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={vi.fn()}
      />,
    );

    fireEvent.change(ta(), { target: { value: 'hello' } });
    fireEvent.keyDown(ta(), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello', []);
    expect(ta().value).toBe('');

    // 切走再切回 s1：草稿表里不该残留已发送的 'hello'。
    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s2"
        onSend={onSend}
        onSetModel={vi.fn()}
      />,
    );
    rerender(
      <Composer
        models={[]}
        currentModel={null}
        sessionId="s1"
        onSend={onSend}
        onSetModel={vi.fn()}
      />,
    );
    expect(ta().value).toBe('');
  });
});

describe('模型菜单 provider 分组与勾选', () => {
  it('多 provider 时出现分组标题', () => {
    renderComposer(makeModels(10), 'm0');
    const menu = openMenu();
    // 两个 provider 各成一组；用 class 精确取分组标题（避免撞到每项的 provider 副标签）。
    const heads = Array.from(
      menu.querySelectorAll('.otto-modelmenu__grouphead'),
    ).map((el) => el.textContent);
    expect(heads).toContain('anthropic');
    expect(heads).toContain('openai');
  });

  it('当前模型仍被勾选高亮（分组不破坏 active 态）', () => {
    renderComposer(makeModels(10), 'm3');
    const menu = openMenu();
    const active = menu.querySelector('.otto-modelmenu__item--active');
    expect(active).toBeTruthy();
    expect(active?.getAttribute('aria-selected')).toBe('true');
    expect(active?.textContent).toContain('模型-04'); // m3 → 第 4 个
  });
});
