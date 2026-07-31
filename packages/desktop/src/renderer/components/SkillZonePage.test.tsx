/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnterpriseSkillMarketItem } from '../../preload/index.js';
import { SkillZonePage } from './SkillZonePage.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { otto?: unknown }).otto;
});

function skill(overrides: Partial<EnterpriseSkillMarketItem> = {}): EnterpriseSkillMarketItem {
  return {
    id: 'skill-1',
    organizationId: 'org-1',
    slug: 'monthly-report',
    name: '月报整理',
    description: '根据工作日志整理月报。',
    department: '财务部',
    visibility: 'department',
    status: 'active',
    authorAccountId: 'author-1',
    authorName: '张悦',
    contentHash: 'hash-1',
    version: 2,
    installCount: 12,
    usageCount: 20,
    successCount: 18,
    failureCount: 2,
    rating: 4.8,
    ratingCount: 6,
    installedVersion: null,
    reviewedBy: 'admin-1',
    reviewedAt: '2026-07-30T08:00:00.000Z',
    createdAt: '2026-07-30T07:00:00.000Z',
    updatedAt: '2026-07-30T08:00:00.000Z',
    ...overrides,
  };
}

function installBridge(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enterpriseSkillLocalList: vi.fn(async () => []),
    enterpriseSkillList: vi.fn(async () => [skill()]),
    enterpriseSkillSubmit: vi.fn(),
    enterpriseSkillReview: vi.fn(),
    enterpriseSkillInstall: vi.fn(async () => ({ skill: skill({ installedVersion: 2 }), installedPath: 'C:/skills/monthly-report/SKILL.md' })),
    enterpriseSkillRate: vi.fn(async () => skill()),
    enterpriseSkillLeaderboard: vi.fn(async () => ({
      skills: [{ ...skill(), rank: 1, score: 91.2, successRate: 0.9 }],
      contributors: [{ rank: 1, accountId: 'author-1', name: '张悦', skillCount: 1, installCount: 12, usageCount: 20, score: 45.5 }],
      generatedAt: '2026-07-30T08:00:00.000Z',
    })),
    ...overrides,
  };
}

describe('SkillZonePage', () => {
  it('支持市场检索、安装、排序与结构化排行榜', async () => {
    const bridge = installBridge();
    (window as unknown as { otto: unknown }).otto = bridge;

    render(<SkillZonePage accountId="member-1" isAdmin={false} onBack={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: '月报整理' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '安装' }));
    await waitFor(() => expect(bridge.enterpriseSkillInstall).toHaveBeenCalledWith('skill-1'));
    expect(await screen.findByText('月报整理 v2 已安装')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('搜索 Skill、作者或部门'), { target: { value: '财务' } });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(bridge.enterpriseSkillList).toHaveBeenCalledWith(expect.objectContaining({ query: '财务' })));

    fireEvent.click(screen.getByRole('button', { name: '排行榜' }));
    expect(await screen.findByText('91.2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '贡献榜' }));
    expect(await screen.findByText('贡献分')).toBeTruthy();
  });

  it('将本机 Skill 投稿接入审核，并仅向管理员展示审核入口', async () => {
    const enterpriseSkillSubmit = vi.fn(async () => ({ outcome: 'submitted', skill: skill({ status: 'pending_review' }) }));
    const enterpriseSkillReview = vi.fn(async () => skill({ status: 'active' }));
    const enterpriseSkillList = vi.fn(async (input: { scope?: string }) => input.scope === 'review'
      ? [skill({ status: 'pending_review' })]
      : []);
    const bridge = installBridge({
      enterpriseSkillLocalList: vi.fn(async () => [{ name: 'auto-budget', description: '预算核对流程', kind: 'auto' }]),
      enterpriseSkillList,
      enterpriseSkillSubmit,
      enterpriseSkillReview,
    });
    (window as unknown as { otto: unknown }).otto = bridge;

    render(<SkillZonePage accountId="admin-1" isAdmin onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '我的 Skill' }));
    expect(await screen.findByText('预算核对流程')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '提交审核' }));
    await waitFor(() => expect(enterpriseSkillSubmit).toHaveBeenCalledWith({
      localSkillName: 'auto-budget',
      visibility: 'department',
    }));

    fireEvent.click(screen.getByRole('button', { name: '审核' }));
    expect(await screen.findByRole('button', { name: '公司上架' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '公司上架' }));
    await waitFor(() => expect(enterpriseSkillReview).toHaveBeenCalledWith('skill-1', 'approve', 'company'));
  });
});
