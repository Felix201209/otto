/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSettingsTabVisible,
  resolveInitialSettingsTab,
  SettingsHubPage,
} from './SettingsHubPage.js';

vi.mock('./SoftwareUpdatePanel.js', () => ({
  SoftwareUpdatePanel: () => 'update-panel',
}));
vi.mock('./hub/SettingsPanels.js', () => ({
  PrefsPanel: () => 'prefs-panel',
  McpPanel: () => 'mcp-panel',
  ExtensionsPanel: () => 'extensions-panel',
  IdePanel: () => 'ide-panel',
}));
vi.mock('./hub/FeishuPanel.js', () => ({ FeishuPanel: () => 'feishu-panel' }));
vi.mock('./hub/LocalAgentPanel.js', () => ({
  LocalAgentPanel: () => 'local-agent-panel',
}));
vi.mock('./hub/DiagnosticsPanels.js', () => ({
  DoctorPanel: () => 'doctor-panel',
  ContextPanel: () => 'context-panel',
  WorkflowsPanel: () => 'workflows-panel',
}));
vi.mock('./hub/WorkspacePanels.js', () => ({
  TodosPanel: () => 'todos-panel',
  MemoryPanel: () => 'memory-panel',
  SkillsPanel: () => 'skills-panel',
  ToolsPanel: () => 'tools-panel',
}));
vi.mock('./hub/ProductWorkspacePanels.js', () => ({
  EnterpriseModelsPanel: () => 'models-panel',
  OrganizationPanel: () => 'organization-panel',
}));
vi.mock('./hub/SearchPanel.js', () => ({ SearchPanel: () => 'search-panel' }));
vi.mock('./hub/PrivacyDataPanel.js', () => ({
  PrivacyDataPanel: () => 'privacy-panel',
}));

afterEach(cleanup);

describe('SettingsHubPage internal-test navigation', () => {
  it('hides the unfinished enterprise local-agent pairing entry', () => {
    expect(isSettingsTabVisible('organization')).toBe(true);
    expect(isSettingsTabVisible('privacy')).toBe(true);
    expect(isSettingsTabVisible('feishu')).toBe(true);
    expect(isSettingsTabVisible('local-agent')).toBe(false);
  });

  it('does not allow a hidden local-agent tab to be opened directly', () => {
    expect(resolveInitialSettingsTab('local-agent')).toBe('prefs');
    expect(resolveInitialSettingsTab('organization')).toBe('organization');
  });

  it('omits the pairing button and renders the safe fallback for a direct request', () => {
    render(
      React.createElement(SettingsHubPage, {
        data: {
          state: { lastError: null, settings: null },
          actions: { refreshSettings: vi.fn() },
        } as never,
        update: { actions: { markBadgeSeen: vi.fn() } } as never,
        activeSession: null,
        onBack: vi.fn(),
        initialTab: 'local-agent',
        product: {} as never,
        models: [],
        enterpriseAccount: {
          id: 'account-1',
          organizationId: 'org-1',
          organizationName: '北辰科技',
          employeeId: null,
          username: 'felix',
          phone: null,
          name: 'Felix',
          role: null,
          department: null,
          positionId: null,
          positionTitle: null,
          isAdmin: false,
          status: 'active',
          tags: [],
          createdAt: '',
          updatedAt: '',
        },
      }),
    );

    expect(screen.queryByRole('button', { name: '接入企业' })).toBeNull();
    expect(
      screen
        .getByRole('button', { name: '外观与回复' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('opens every visible settings area and runs only its required refresh action', () => {
    const actionNames = [
      'refreshSettings',
      'refreshMcpServers',
      'refreshSearchConfig',
      'refreshContextBreakdown',
      'refreshTodos',
      'refreshMemory',
      'refreshSkills',
      'refreshTools',
      'refreshWorkflows',
      'refreshExtensions',
      'refreshIdeStatus',
      'clearError',
    ] as const;
    const actions = Object.fromEntries(
      actionNames.map((name) => [name, vi.fn()]),
    ) as Record<(typeof actionNames)[number], ReturnType<typeof vi.fn>>;
    const markBadgeSeen = vi.fn();
    const onBack = vi.fn();
    const activeSession = { sessionId: 'session-1' };
    const view = render(
      React.createElement(SettingsHubPage, {
        data: {
          state: { lastError: 'test error', settings: null },
          actions,
        } as never,
        update: { actions: { markBadgeSeen } } as never,
        activeSession: activeSession as never,
        onBack,
        initialTab: 'mcp',
        product: {} as never,
        models: [],
        enterpriseAccount: {
          id: 'account-1',
          organizationId: 'org-1',
          organizationName: 'Otto',
          employeeId: null,
          username: 'user',
          phone: null,
          name: 'User',
          role: null,
          department: null,
          positionId: null,
          positionTitle: null,
          isAdmin: true,
          status: 'active',
          tags: [],
          createdAt: '',
          updatedAt: '',
        },
        uiMode: 'work',
        onUiModeChange: vi.fn(),
        onManageAccounts: vi.fn(),
      }),
    );

    expect(actions.refreshSettings).toHaveBeenCalledOnce();
    expect(actions.refreshMcpServers).toHaveBeenCalledOnce();
    expect(screen.getByText('mcp-panel')).toBeTruthy();

    const navButtons = Array.from(
      view.container.querySelectorAll<HTMLButtonElement>(
        'button.otto-hub__nav-item',
      ),
    );
    expect(navButtons).toHaveLength(17);

    const expectedPanels = [
      'prefs-panel',
      'search-panel',
      'update-panel',
      'organization-panel',
      'privacy-panel',
      'feishu-panel',
      'models-panel',
      'mcp-panel',
      'extensions-panel',
      'ide-panel',
      'doctor-panel',
      'context-panel',
      'workflows-panel',
      'todos-panel',
      'memory-panel',
      'skills-panel',
      'tools-panel',
    ];
    navButtons.forEach((button, index) => {
      fireEvent.click(button);
      expect(screen.getByText(expectedPanels[index])).toBeTruthy();
    });

    expect(actions.refreshSearchConfig).toHaveBeenCalledOnce();
    expect(markBadgeSeen).toHaveBeenCalledOnce();
    expect(actions.refreshContextBreakdown).toHaveBeenCalledWith('session-1');
    expect(actions.refreshTodos).toHaveBeenCalledOnce();
    expect(actions.refreshMemory).toHaveBeenCalledOnce();
    expect(actions.refreshSkills).toHaveBeenCalledOnce();
    expect(actions.refreshTools).toHaveBeenCalledWith('session-1');
    expect(actions.refreshWorkflows).toHaveBeenCalledOnce();
    expect(actions.refreshExtensions).toHaveBeenCalledOnce();
    expect(actions.refreshIdeStatus).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('alert').querySelector('button')!);
    expect(actions.clearError).toHaveBeenCalledOnce();

    const page = view.container.querySelector<HTMLElement>('.otto-hub-page')!;
    fireEvent.keyDown(page, { key: 'Enter' });
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.keyDown(page, { key: 'Escape' });
    expect(onBack).toHaveBeenCalledOnce();

    const advanced = view.container.querySelector<HTMLButtonElement>(
      'button.otto-hub__nav-advanced',
    )!;
    fireEvent.click(advanced);
    expect(screen.getByText('prefs-panel')).toBeTruthy();
    expect(advanced.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(advanced);
    expect(advanced.getAttribute('aria-expanded')).toBe('true');
  });
});
