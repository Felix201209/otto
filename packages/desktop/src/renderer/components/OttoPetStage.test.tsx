/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { OttoPetStage, PET_ANIMATIONS } from './OttoPetStage.js';

vi.mock('../assets/otto-pet-atlas.png', () => ({ default: 'otto-pet-atlas.png' }));
vi.mock('../assets/otto-login-mascot-hd.png', () => ({ default: 'otto-login-mascot-hd.png' }));

const matchMedia = (matches: boolean): typeof window.matchMedia =>
  vi.fn().mockReturnValue({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = matchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OttoPetStage', () => {
  it('小宠物作为右下角挂件显示真实工作状态和红绿灯', () => {
    const { rerender } = render(<OttoPetStage running={false} variant="widget" />);

    expect(screen.getByRole('complementary', { name: 'Otto 小宠物工作状态' })).toBeTruthy();
    expect(screen.getByText('等待下一项工作')).toBeTruthy();
    expect(screen.getByLabelText('空闲待命')).toBeTruthy();

    rerender(<OttoPetStage running variant="widget" workLabel="正在运行工具" />);
    expect(screen.getByText('正在运行工具')).toBeTruthy();
    expect(screen.getByLabelText('工作中')).toBeTruthy();
  });

  it('声明完整 9 行动画协议，行号与 hatch-pet atlas 一一对应', () => {
    expect(Object.values(PET_ANIMATIONS).map((animation) => animation.row)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('按 idle 行的逐帧时长推进 spritesheet 帧', () => {
    const { container } = render(<OttoPetStage running={false} variant="widget" />);
    const motion = container.querySelector<HTMLElement>('[data-state="idle"]');
    expect(motion?.dataset.frame).toBe('0');

    act(() => vi.advanceTimersByTime(280));
    expect(motion?.dataset.frame).toBe('1');
  });

  it('系统要求减少动效时固定在 idle 首帧', () => {
    window.matchMedia = matchMedia(true);
    const { container } = render(<OttoPetStage running variant="widget" />);
    const motion = container.querySelector<HTMLElement>('[data-state="idle"]');
    expect(motion?.dataset.reducedMotion).toBe('true');

    act(() => vi.advanceTimersByTime(5000));
    expect(motion?.dataset.frame).toBe('0');
  });

  it('Otto 真正运行时切到右向跑步行', () => {
    const { container } = render(<OttoPetStage running variant="widget" />);
    expect(
      container.querySelector<HTMLElement>('[data-state="running-right"]'),
    ).toBeTruthy();
  });

  it('登录页使用独立高清吉祥物，并移除低分辨率图集和地面装饰', () => {
    const { container } = render(<OttoPetStage running={false} variant="login" />);
    const stage = container.querySelector<HTMLElement>('[data-testid="otto-pet-stage"]');
    const mascot = container.querySelector<HTMLImageElement>('.otto-pet-stage__login-mascot');

    expect(stage?.classList.contains('otto-pet-stage--login')).toBe(true);
    expect(container.querySelector('.otto-pet-stage__head')).toBeNull();
    expect(container.querySelector('.otto-pet-stage__floor')).toBeNull();
    expect(container.querySelector('.otto-pet-stage__sprite')).toBeNull();
    expect(mascot?.src).toContain('otto-login-mascot-hd.png');
  });
});
