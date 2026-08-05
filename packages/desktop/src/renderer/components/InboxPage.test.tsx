/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EnterpriseAccount,
  EnterpriseUnreadMessageNotification,
} from '../../preload/index.js';
import { InboxPage } from './InboxPage.js';

const account: EnterpriseAccount = {
  id: 'member-1',
  organizationId: 'organization-1',
  organizationName: '测试企业',
  employeeId: null,
  username: 'member-1',
  phone: null,
  name: '测试成员',
  role: '成员',
  department: '研发部',
  positionId: null,
  positionTitle: '工程师',
  isAdmin: false,
  status: 'active',
  tags: [],
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
};

beforeEach(() => {
  (window as unknown as { otto: unknown }).otto = {
    enterpriseMessagesUnread: vi.fn(async () => (
      undefined as unknown as EnterpriseUnreadMessageNotification[]
    )),
    enterpriseOrganizationView: vi.fn(async () => ({ members: [] })),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('InboxPage response hardening', () => {
  it('keeps the inbox usable when an older bridge returns no notification array', async () => {
    render(
      <InboxPage
        enterpriseAccount={account}
        onBack={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('暂无消息')).toBeTruthy();
    });
    expect(screen.getByRole('region', { name: '我的消息' })).toBeTruthy();
  });
});
