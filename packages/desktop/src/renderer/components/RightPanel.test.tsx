/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
} from '@testing-library/react';
import type { ProductWorkspaceSnapshot } from 'otto-server';
import { RightPanel } from './RightPanel.js';
import { BASE_AGENT_PROFILES } from '../agents/departmentAgents.js';

afterEach(() => {
  cleanup();
  delete (window as unknown as { otto?: unknown }).otto;
});

function installBridge() {
  (window as unknown as { otto: unknown }).otto = {
    parkConfig: async () => null,
    workLogRecent: async () => [],
    workLogToday: async () => ({
      summary: '今天还没有工作记录。',
      date: '2026-07-10',
      totalActions: 0,
      workResults: 0,
    }),
  };
}

function enterpriseWorkspace(): ProductWorkspaceSnapshot {
  return {
    schemaVersion: 1,
    context: {
      edition: 'enterprise',
      role: 'company_owner',
      userId: 'owner-1',
      displayName: 'Felix',
      companyId: 'company-1',
      capabilities: [
        'agent:base',
        'model:otto',
        'skill:built-in',
        'skill:auto-create',
        'organization:read',
        'organization:manage',
      ],
    },
    managerWorkspace: {
      profile: {
        managerId: 'owner-1',
        managerName: 'Felix',
        companyName: '宏创 AI',
        createdAt: '2026-07-10T00:00:00.000Z',
      },
      context: {
        edition: 'enterprise',
        role: 'company_owner',
        userId: 'owner-1',
        companyId: 'company-1',
        capabilities: [],
      },
      organization: {
        rootCompanyId: 'company-1',
        companies: [{ id: 'company-1', name: '宏创 AI', ownerUserId: 'owner-1' }],
        departments: [{ id: 'dept-1', companyId: 'company-1', name: 'CEO 办公室' }],
        positions: [{
          id: 'position-1',
          companyId: 'company-1',
          departmentId: 'dept-1',
          title: 'CEO',
          incumbentUserId: 'owner-1',
        }],
      },
    },
    members: [{
      userId: 'owner-1',
      displayName: 'Felix',
      companyId: 'company-1',
      departmentId: 'dept-1',
      positionId: 'position-1',
      role: 'company_owner',
    }],
    friends: [],
    credits: { balance: 0, frozen: 0, status: 'design-preview' },
  };
}

describe('RightPanel fixed Agent catalog', () => {
  it('shows the fixed 9 Agents in personal mode', () => {
    installBridge();

    render(<RightPanel busy={false} />);

    for (const profile of BASE_AGENT_PROFILES) {
      expect(screen.getByText(profile.name)).toBeTruthy();
    }
    expect(screen.queryByText('企业AI自主开发')).toBeNull();
    expect(screen.queryByText('CEO Agent')).toBeNull();
    expect(screen.queryByText('战略与竞争 Agent')).toBeNull();
  });

  it('keeps enterprise mode on the same fixed 9-Agent catalog', () => {
    installBridge();

    render(
      <RightPanel
        busy={false}
        mode="enterprise"
        workspace={enterpriseWorkspace()}
        onOpenSkillZone={vi.fn()}
      />,
    );

    expect(screen.getByText('企业工作 Agent')).toBeTruthy();
    expect(screen.getByText('PPT 创作专家')).toBeTruthy();
    expect(screen.getByText('品牌营销文案')).toBeTruthy();
    expect(screen.queryByText('CEO Agent')).toBeNull();
    expect(screen.queryByText('产品需求 Agent')).toBeNull();
  });
});
