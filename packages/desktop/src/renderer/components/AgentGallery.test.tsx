/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { AgentGallery } from './AgentGallery.js';
import {
  BASE_AGENT_PROFILES,
  DEPARTMENT_AGENT_PROFILES,
  getEnterpriseAgentProfiles,
} from '../agents/departmentAgents.js';

function renderGallery(mode: 'personal' | 'enterprise' = 'personal') {
  const onLaunch = vi.fn();
  const onBack = vi.fn();
  render(<AgentGallery mode={mode} onLaunch={onLaunch} onBack={onBack} />);
  return { onLaunch, onBack };
}

describe('AgentGallery', () => {
  it('renders the fixed 9-Agent catalog', () => {
    renderGallery();

    for (const profile of BASE_AGENT_PROFILES) {
      expect(screen.getByText(profile.name)).toBeTruthy();
    }
    expect(screen.getByText('PPT 创作专家')).toBeTruthy();
    expect(screen.getByText('会议 Agent')).toBeTruthy();
    expect(screen.getByText('Word 公文撰写')).toBeTruthy();
    expect(screen.getByText('Excel 数据表格')).toBeTruthy();
    expect(screen.getByText('市场竞品调研')).toBeTruthy();
    expect(screen.getByText(`共 ${BASE_AGENT_PROFILES.length} 位专家 · 点击即可开始新对话`)).toBeTruthy();
  });

  it('does not render department Agents', () => {
    renderGallery('enterprise');

    expect(DEPARTMENT_AGENT_PROFILES).toHaveLength(0);
    expect(getEnterpriseAgentProfiles('company_owner')).toHaveLength(9);
    expect(screen.queryByText('战略与竞争 Agent')).toBeNull();
    expect(screen.queryByText('产品需求 Agent')).toBeNull();
  });

  it('launches only the selected profile', () => {
    const { onLaunch } = renderGallery();

    fireEvent.click(screen.getByText('PPT 创作专家'));
    fireEvent.click(screen.getByText('Excel 数据表格'));

    expect(onLaunch.mock.calls.map(([profile]) => profile.id)).toEqual(['ppt', 'sheet']);
    expect(onLaunch.mock.calls.every((call) => call.length === 1)).toBe(true);
  });

  it('returns to chat when clicking the back button', () => {
    const { onBack } = renderGallery();

    fireEvent.click(screen.getByRole('button', { name: '返回对话' }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('returns to chat on Escape', () => {
    const { onBack } = renderGallery();

    fireEvent.keyDown(screen.getByRole('region', { name: '专家目录' }), {
      key: 'Escape',
    });

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
