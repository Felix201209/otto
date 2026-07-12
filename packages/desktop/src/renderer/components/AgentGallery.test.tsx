/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/** AgentGallery v1.7：个人基础 Agent 与企业部门 Agent 分层展示。 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { AgentGallery } from './AgentGallery.js';
import {
  BASE_AGENT_PROFILES,
  DEPARTMENT_AGENT_PROFILES,
  ENTERPRISE_CEO_PROFILE,
  PERSONAL_OTTO_PROFILE,
} from '../agents/departmentAgents.js';

function renderGallery() {
  const onLaunch = vi.fn();
  const onBack = vi.fn();
  render(<AgentGallery onLaunch={onLaunch} onBack={onBack} />);
  return { onLaunch, onBack };
}

describe('AgentGallery（页面）', () => {
  it('个人版渲染 Otto、会议 Agent 与 8 位通用专家', () => {
    renderGallery();
    expect(screen.queryByText(/不会自动发送长消息/)).toBeNull();
    for (const profile of BASE_AGENT_PROFILES) {
      expect(screen.getByText(profile.name)).toBeTruthy();
    }
    expect(screen.queryByText(DEPARTMENT_AGENT_PROFILES[0].name)).toBeNull();
    expect(screen.getByText('PPT 创作专家')).toBeTruthy();
    expect(screen.getByText('Word 公文撰写')).toBeTruthy();
    expect(screen.getByText('Excel 数据表格')).toBeTruthy();
    expect(screen.getByText('市场竞品调研')).toBeTruthy();
    expect(screen.getByText(`共 ${BASE_AGENT_PROFILES.length} 位专家`)).toBeTruthy();
  });

  it('点击会议 Agent 只回传 profile，不发送 kickoff', () => {
    const { onLaunch } = renderGallery();
    const target = BASE_AGENT_PROFILES[1];
    fireEvent.click(screen.getByText(target.name));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    expect(onLaunch).toHaveBeenCalledWith(target);
  });

  it('企业版展示全部部门基础 Agent', () => {
    render(
      <AgentGallery
        mode="enterprise"
        onLaunch={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(ENTERPRISE_CEO_PROFILE.name)).toBeTruthy();
    expect(screen.queryByText(PERSONAL_OTTO_PROFILE.name)).toBeNull();
    expect(screen.getByText(DEPARTMENT_AGENT_PROFILES[0].name)).toBeTruthy();
    expect(
      screen.getByText(
        `共 ${BASE_AGENT_PROFILES.length + DEPARTMENT_AGENT_PROFILES.length} 位专家`,
      ),
    ).toBeTruthy();
  });

  it('点「返回对话」→ onBack', () => {
    const { onBack } = renderGallery();
    fireEvent.click(screen.getByRole('button', { name: '返回对话' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('Esc → onBack', () => {
    const { onBack } = renderGallery();
    fireEvent.keyDown(screen.getByRole('region', { name: '专家目录' }), {
      key: 'Escape',
    });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
