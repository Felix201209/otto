/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { PrefsPanel } from './SettingsPanels.js';

afterEach(cleanup);

beforeEach(() => {
  (window as unknown as { otto: unknown }).otto = {
    themeGet: async () => 'system',
    themeSet: vi.fn(async () => undefined),
  };
});

function settingsData(agentStyle = 'default') {
  const setSetting = vi.fn();
  const value = {
    state: {
      settings: {
        agentStyle,
        healthyUse: false,
        preferredLanguage: '',
      },
      mcpServers: [],
      contextBreakdown: null,
      doctorReport: null,
      doctorRunning: false,
      todos: [],
      memoryFiles: [],
      skills: [],
      tools: [],
      compressRunning: false,
      compressMessage: null,
      exportMessage: null,
      workflows: [],
      extensions: [],
      ideStatus: null,
      statsSnapshot: null,
      knowledgeEntries: [],
      lastError: null,
    },
    actions: { setSetting },
  } as unknown as UseSettingsData;
  return { value, setSetting };
}

describe('PrefsPanel 外观与回复', () => {
  it('面向普通用户展示工作场景，不暴露开发工具品牌名', () => {
    const { value } = settingsData();
    render(<PrefsPanel data={value} />);

    expect(screen.getByText('外观与回复')).toBeTruthy();
    for (const label of [
      '平时聊天',
      '直接做事',
      '复杂任务',
      '工作代码（协作开发）',
      '简洁开发（直接精炼）',
      '企业办公（资料与会议）',
      '协作推进（边讲边做）',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(
      screen.getByText('不需要理解模型参数，只选最接近你的习惯。'),
    ).toBeTruthy();

    expect(
      screen.queryByText(/Claude|Codex|Cursor|Augment|Antigravity|Windsurf/i),
    ).toBeNull();
  });

  it('新文案继续写入旧的稳定配置值，已有用户配置无需迁移', () => {
    const { value, setSetting } = settingsData('default');
    render(<PrefsPanel data={value} />);

    fireEvent.click(screen.getByRole('button', { name: /工作代码（协作开发）/ }));
    expect(setSetting).toHaveBeenCalledWith('agentStyle', 'cursor');

    fireEvent.click(screen.getByRole('button', { name: /企业办公（资料与会议）/ }));
    expect(setSetting).toHaveBeenCalledWith('agentStyle', 'antigravity');
  });
});
