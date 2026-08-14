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
    enterpriseFederationMessageSend: vi.fn(async () => ({
      id: 'federation-a2a-proposal',
      senderAccountId: account.id,
      recipientAccountId: 'deployment-b:remote-account',
      content: 'encrypted proposal placeholder',
      createdAt: '2026-08-12T00:02:00.000Z',
      readAt: null,
      federated: true,
      contactId: 'contact-remote',
      federationMessageType: 'chat.message',
      direction: 'outbound',
      deliveryStatus: 'queued',
      trustState: 'verified',
    })),
    enterpriseFederationContactVerification: vi.fn(async () => ({
      safetyNumber: '1234567890123456',
      qrPayload: 'OTTO_E2EE_VERIFY_V1:test',
      deviceFingerprints: ['a'.repeat(64), 'b'.repeat(64)],
      verifiedAt: null,
    })),
    enterpriseFederationAttachmentSave: vi.fn(async () => ({
      id: 'fattachment-one',
      fileName: 'evidence.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      path: 'D:\\Downloads\\evidence.pdf',
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
      attachments: [{
        id: 'fattachment-one',
        fileName: 'evidence.pdf',
        mimeType: 'application/pdf',
        size: 1024,
      }],
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
    expect(screen.getByText('evidence.pdf')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(bridge.enterpriseFederationAttachmentSave).toHaveBeenCalledWith(
        contact.id,
        'federation-message-1',
        'fattachment-one',
        'evidence.pdf',
      );
    });
  });

  it('only lets a verified contact receive an encrypted A2A proposal', async () => {
    const contact: EnterpriseFederationContact = {
      id: 'contact-remote',
      identity: 'deployment-b:remote-account',
      remoteDeploymentId: 'deployment-b',
      remotePrincipalId: 'remote-account',
      displayName: '远程同事',
      deploymentDisplayName: '北京私有部署',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
      unreadCount: 0,
      trustState: 'verified',
      keyFingerprint: 'b'.repeat(64),
    };
    const bridge = window.otto as unknown as Record<string, ReturnType<typeof vi.fn>>;
    bridge.enterpriseFederationContacts.mockResolvedValue([contact]);

    render(
      <InboxPage
        enterpriseAccount={account}
        onBack={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole('listitem', { name: /远程同事/ }));
    const askButton = await screen.findByRole('button', { name: '询问对方 Otto' });
    expect((askButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: '回复消息' }), {
      target: { value: '你明天下午是否方便开会？' },
    });
    expect((askButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(askButton);

    await waitFor(() => {
      expect(bridge.enterpriseFederationMessageSend).toHaveBeenCalledTimes(1);
    });
    const [contactId, content] = bridge.enterpriseFederationMessageSend.mock.calls[0]!;
    expect(contactId).toBe(contact.id);
    expect(content).toMatch(/^OTTO_ATOA_REQUEST /u);
    expect(content).toContain('你明天下午是否方便开会？');
  });
});
