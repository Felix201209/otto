/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EnterpriseAccount,
  EnterpriseFederationContact,
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
    enterpriseFederationContacts: vi.fn(async () => []),
    enterpriseFederationMessagesList: vi.fn(async () => []),
    enterpriseFederationContactVerification: vi.fn(async () => ({
      safetyNumber: '1234567890123456',
      qrPayload: 'OTTO_E2EE_VERIFY_V1:test',
      deviceFingerprints: ['a'.repeat(64), 'b'.repeat(64)],
      verifiedAt: null,
    })),
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

  it('opens a federated E2EE conversation from the same contact list', async () => {
    const contact: EnterpriseFederationContact = {
      id: 'contact-remote',
      identity: 'deployment-b:remote-account',
      remoteDeploymentId: 'deployment-b',
      remotePrincipalId: 'remote-account',
      displayName: '远程同事',
      deploymentDisplayName: '北京私有部署',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: '2026-08-12T00:01:00.000Z',
      unreadCount: 1,
      trustState: 'unverified',
      keyFingerprint: 'b'.repeat(64),
    };
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;
    bridge.enterpriseFederationContacts.mockResolvedValue([contact]);
    bridge.enterpriseFederationMessagesList.mockResolvedValue([{
      id: 'federation-message-1',
      senderAccountId: contact.identity,
      recipientAccountId: account.id,
      content: '跨服务器消息正文',
      createdAt: '2026-08-12T00:01:00.000Z',
      readAt: null,
      attachments: [],
      e2ee: true,
      e2eeProtocol: 'device-envelope-v1',
      contentType: 'message',
      inReplyToMessageId: null,
      federated: true,
      contactId: contact.id,
      direction: 'inbound',
      deliveryStatus: 'received',
      trustState: 'unverified',
    }]);

    render(
      <InboxPage
        enterpriseAccount={account}
        onBack={() => undefined}
      />,
    );

    const contactButton = await screen.findByRole('listitem', { name: /远程同事/ });
    fireEvent.click(contactButton);

    await waitFor(() => {
      expect(screen.getByText('跨服务器消息正文')).toBeTruthy();
    });
    expect(screen.getByText('端到端加密安全号码')).toBeTruthy();
    expect(screen.getByText('1234 5678 9012 3456')).toBeTruthy();
    expect(screen.getByText('未核验')).toBeTruthy();
  });
});
