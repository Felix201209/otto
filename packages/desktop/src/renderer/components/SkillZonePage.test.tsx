/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillZonePage } from './SkillZonePage.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { otto?: unknown }).otto;
});

describe('SkillZonePage', () => {
  it('部门/公司市场与个人/Skill 排行榜读取各自真实数据源', async () => {
    const skillShareList = vi.fn(async () => ({ text: '部门 Skill A' }));
    const skillMarketplace = vi.fn(async () => ({ text: '公司 Skill B' }));
    const skillLeaderboard = vi.fn(async () => ({
      starBoard: '个人贡献榜',
      leaderboard: 'Skill 质量榜',
    }));
    (window as unknown as { otto: unknown }).otto = {
      skillShareList,
      skillMarketplace,
      skillLeaderboard,
    };

    render(<SkillZonePage onBack={vi.fn()} />);
    expect(await screen.findByText('部门 Skill A')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '公司市场' }));
    expect(await screen.findByText('公司 Skill B')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '排行榜' }));
    expect(await screen.findByText('个人贡献榜')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Skill 榜' }));
    expect(await screen.findByText('Skill 质量榜')).toBeTruthy();
    await waitFor(() => expect(skillLeaderboard).toHaveBeenCalled());
  });
});
