/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseSettingsData } from '../../state/useSettingsData.js';
import { PrefsPanel } from './SettingsPanels.js';

afterEach(cleanup);

beforeEach(() => {
  window.localStorage.clear();
  (window as unknown as { otto: unknown }).otto = {
    themeGet: async () => 'system',
    themeSet: vi.fn(async () => undefined),
  };
});

function settingsData(
  agentStyle = 'default',
  overrides: Partial<{
    healthyUse: boolean;
    preferredLanguage: string;
  }> = {},
) {
  const setSetting = vi.fn();
  const value = {
    state: {
      settings: {
        agentStyle,
        healthyUse: overrides.healthyUse ?? false,
        preferredLanguage: overrides.preferredLanguage ?? '',
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
    expect(screen.queryByText('推荐设置已生效')).toBeNull();
    expect(screen.queryByText('不知道怎么选时保持默认就好，所有选项都会立即生效。')).toBeNull();
  });

  it('新文案继续写入旧的稳定配置值，已有用户配置无需迁移', () => {
    const { value, setSetting } = settingsData('default');
    render(<PrefsPanel data={value} />);

    fireEvent.click(screen.getByRole('button', { name: /工作代码（协作开发）/ }));
    expect(setSetting).toHaveBeenCalledWith('agentStyle', 'cursor');

    fireEvent.click(screen.getByRole('button', { name: /企业办公（资料与会议）/ }));
    expect(setSetting).toHaveBeenCalledWith('agentStyle', 'antigravity');
  });

  it('只把当前页面的真实偏好恢复为默认值', async () => {
    window.localStorage.setItem('otto.pet-widget.enabled', '1');
    const themeSet = vi.fn(async () => undefined);
    (window as unknown as { otto: unknown }).otto = {
      themeGet: async () => 'dark',
      themeSet,
    };
    const { value, setSetting } = settingsData('cursor', {
      healthyUse: false,
      preferredLanguage: '中文',
    });
    const onUiModeChange = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PrefsPanel
        data={value}
        uiMode="work"
        onUiModeChange={onUiModeChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '深色' }).className).toContain('is-active');
    });
    fireEvent.click(screen.getByRole('button', { name: '恢复默认设置' }));

    expect(confirm).toHaveBeenCalledWith(
      '恢复外观与回复的默认设置？\n\n这会重置本页面的界面、主题和回复偏好，不会影响账号、工作目录或其他设置。',
    );
    await waitFor(() => {
      expect(onUiModeChange).toHaveBeenCalledWith('conversational');
      expect(themeSet).toHaveBeenCalledWith('system');
      expect(setSetting).toHaveBeenCalledWith('agentStyle', 'default');
      expect(setSetting).toHaveBeenCalledWith('healthyUse', true);
      expect(setSetting).toHaveBeenCalledWith('preferredLanguage', '');
      expect(window.localStorage.getItem('otto.pet-widget.enabled')).toBe('0');
      expect(screen.getByRole('button', { name: '已恢复' })).toBeTruthy();
    });
  });

  it('所有项目均为默认值时禁用恢复按钮', async () => {
    const { value } = settingsData('default', { healthyUse: true });
    render(<PrefsPanel data={value} uiMode="conversational" />);

    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: '恢复默认设置' }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });
  });
});

describe('PrefsPanel UI mode selection', () => {
  it('shows the two official UI modes and switches without changing business settings', () => {
    const { value, setSetting } = settingsData();
    const onUiModeChange = vi.fn();
    render(
      <PrefsPanel
        data={value}
        uiMode="work"
        onUiModeChange={onUiModeChange}
      />,
    );

    expect(screen.getByRole('radio', { name: /工作式 UI/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /对话式 UI/ }));
    expect(onUiModeChange).toHaveBeenCalledWith('conversational');
    expect(setSetting).not.toHaveBeenCalled();
  });
});
