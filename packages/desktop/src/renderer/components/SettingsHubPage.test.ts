/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSettingsTabVisible,
  resolveInitialSettingsTab,
  SettingsHubPage,
} from './SettingsHubPage.js';

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
    render(React.createElement(SettingsHubPage, {
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
        id: 'account-1', organizationId: 'org-1', organizationName: '北辰科技',
        employeeId: null, username: 'felix', phone: null, name: 'Felix', role: null,
        department: null, positionId: null, positionTitle: null, isAdmin: false,
        status: 'active', tags: [], createdAt: '', updatedAt: '',
      },
    }));

    expect(screen.queryByRole('button', { name: '接入企业' })).toBeNull();
    expect(
      screen.getByRole('button', { name: '外观与回复' }).getAttribute('aria-current'),
    ).toBe('page');
  });
});
