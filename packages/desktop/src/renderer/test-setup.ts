/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  const existing = window.otto ?? {};
  Object.defineProperty(window, 'otto', {
    configurable: true,
    writable: true,
    value: {
      ...existing,
      send: vi.fn(),
      authorizeFileForAttachment: vi.fn(async (file: File) => `/tmp/${file.name}`),
      enterpriseOrganizationView: vi.fn(async () => ({
        organization: null,
        members: [],
        employeeCount: 0,
      })),
      enterprisePresenceHeartbeat: vi.fn(async () => undefined),
      enterpriseMessagesList: vi.fn(async () => []),
      enterpriseMessagesUnread: vi.fn(async () => []),
      enterpriseMessageSend: vi.fn(async (_peerAccountId: string, content: string) => ({
        id: 'msg_test',
        senderAccountId: 'me',
        recipientAccountId: 'peer',
        content,
        createdAt: new Date(0).toISOString(),
        readAt: null,
      })),
      enterpriseAtoaInbox: vi.fn(async () => []),
      workLogToday: vi.fn(async () => ({
        summary: '',
        date: new Date(0).toISOString().slice(0, 10),
        totalActions: 0,
        workResults: 0,
      })),
      workLogRecent: vi.fn(async () => []),
    } as unknown as Window['otto'],
  });
});
