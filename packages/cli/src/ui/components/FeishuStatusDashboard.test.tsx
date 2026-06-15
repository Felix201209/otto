/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect } from 'vitest';
import { FeishuStatusDashboard } from './FeishuStatusDashboard.js';

const baseProps = {
  routes: {} as Record<string, { projectRoot?: string }>,
  activeGroupChatIds: new Set<string>(),
  groupLogs: {},
  botName: 'dvcode3',
  platform: 'feishu',
  isConnected: true,
  terminalWidth: 100,
};

describe('<FeishuStatusDashboard /> chat name resolution', () => {
  it('shows the resolved group name instead of the chatId when available', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{ oc_abc: { projectRoot: '/home/u/projects/app-one' } }}
        chatNames={{ oc_abc: '我的协作群' }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('我的协作群');
  });

  it('falls back to the chatId when no group name is resolved', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{ oc_unnamed: { projectRoot: '/home/u/projects/app-two' } }}
        chatNames={{}}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('oc_unnamed');
  });

  it('renders the project path (shortened) for a bound route', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{ oc_abc: { projectRoot: '/home/u/projects/easyrouter-codingplan' } }}
        chatNames={{ oc_abc: 'Group A' }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('easyrouter-codingplan');
  });

  it('marks the active chat row distinctly', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{
          oc_active: { projectRoot: '/p/active' },
          oc_idle: { projectRoot: '/p/idle' },
        }}
        activeGroupChatIds={new Set(['oc_active'])}
        chatNames={{ oc_active: 'Active Group', oc_idle: 'Idle Group' }}
      />,
    );
    const frame = lastFrame() ?? '';
    // 活跃群名应出现，且带有活跃标记（🟢 圆点）
    expect(frame).toContain('Active Group');
    expect(frame).toContain('🟢');
  });

  it('marks MULTIPLE concurrently-working chats as active', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{
          oc_a: { projectRoot: '/p/a' },
          oc_b: { projectRoot: '/p/b' },
          oc_c: { projectRoot: '/p/c' },
        }}
        activeGroupChatIds={new Set(['oc_a', 'oc_c'])}
        chatNames={{ oc_a: 'Group A', oc_b: 'Group B', oc_c: 'Group C' }}
      />,
    );
    const frame = lastFrame() ?? '';
    // 两个正在干活的群都应显示，且整体出现活跃绿点
    expect(frame).toContain('Group A');
    expect(frame).toContain('Group C');
    expect(frame).toContain('🟢');
    // 至少出现两个活跃圆点（两个群同时活跃）
    expect((frame.match(/🟢/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('works without the chatNames prop (backward compatible)', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{ oc_legacy: { projectRoot: '/p/legacy' } }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('oc_legacy');
  });
});

describe('<FeishuStatusDashboard /> p2p (bot direct-message) rendering', () => {
  it('renders a p2p chat as a friendly "direct message with bot" label', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{ oc_p2p: { projectRoot: '/home/u/cli-cwd' } }}
        p2pChatIds={new Set(['oc_p2p'])}
      />,
    );
    const frame = lastFrame() ?? '';
    // 应出现私聊文案 + Bot 名（baseProps.botName = 'dvcode3'）
    expect(frame).toMatch(/Direct message with bot|与机器人/i);
    expect(frame).toContain('dvcode3');
    // 不应再裸露 chatId 作为主显示
    expect(frame).not.toContain('oc_p2p');
  });

  it('does NOT apply the p2p label to a normal group chat', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{
          oc_p2p: { projectRoot: '/p/dm' },
          oc_group: { projectRoot: '/p/grp' },
        }}
        p2pChatIds={new Set(['oc_p2p'])}
        chatNames={{ oc_group: 'Team Group' }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Team Group');
    expect(frame).toMatch(/Direct message with bot|与机器人/i);
  });

  it('prefers the p2p label over a (mistakenly) resolved name', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{ oc_p2p: { projectRoot: '/p/dm' } }}
        p2pChatIds={new Set(['oc_p2p'])}
        chatNames={{ oc_p2p: 'Should Not Show' }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Direct message with bot|与机器人/i);
    expect(frame).not.toContain('Should Not Show');
  });

  it('still marks a p2p chat active when it is currently working', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{ oc_p2p: { projectRoot: '/p/dm' } }}
        p2pChatIds={new Set(['oc_p2p'])}
        activeGroupChatIds={new Set(['oc_p2p'])}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Direct message with bot|与机器人/i);
    expect(frame).toContain('🟢');
  });

  it('is backward compatible without the p2pChatIds prop', () => {
    const { lastFrame } = render(
      <FeishuStatusDashboard
        {...baseProps}
        routes={{ oc_x: { projectRoot: '/p/x' } }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('oc_x');
  });
});
