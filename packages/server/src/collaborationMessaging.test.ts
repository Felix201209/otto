/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createDirectMessageFacade,
  type DirectMessageRepositoryStore,
} from './modules/collaboration/index.js';
import { Database } from './modules/data_platform/index.js';

const REQUEST_PREFIX = 'OTTO_ATOA_REQUEST ';
const RESPONSE_PREFIX = 'OTTO_ATOA_RESPONSE ';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      deleted_at TEXT,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );
    CREATE TABLE direct_messages (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      sender_account_id TEXT NOT NULL,
      recipient_account_id TEXT NOT NULL,
      content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (sender_account_id) REFERENCES accounts(id),
      FOREIGN KEY (recipient_account_id) REFERENCES accounts(id)
    );
    CREATE TABLE direct_message_attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
      content BLOB NOT NULL,
      storage_backend TEXT NOT NULL DEFAULT 'sqlite',
      storage_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (message_id) REFERENCES direct_messages(id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );
  `);
  return database;
}

function seedAccounts(database: Database): void {
  database
    .prepare('INSERT INTO organizations (id) VALUES (?), (?)')
    .run('org-a', 'org-b');
  database
    .prepare(
      `INSERT INTO accounts (id, organization_id, name, status, deleted_at)
       VALUES (?, ?, ?, ?, NULL), (?, ?, ?, ?, NULL),
              (?, ?, ?, ?, NULL), (?, ?, ?, ?, NULL),
              (?, ?, ?, ?, NULL)`,
    )
    .run(
      'alice',
      'org-a',
      'Alice',
      'active',
      'bob',
      'org-a',
      'Bob',
      'active',
      'carol',
      'org-a',
      'Carol',
      'active',
      'disabled',
      'org-a',
      'Disabled',
      'disabled',
      'mallory',
      'org-b',
      'Mallory',
      'active',
    );
}

function createStore(database: Database): DirectMessageRepositoryStore {
  let sequence = 0;
  return {
    db: () => database,
    createId: () => `message-${++sequence}`,
    getActiveAccountInOrganization(accountId, organizationId) {
      const row = database
        .prepare(
          `SELECT id, name FROM accounts
           WHERE id = ? AND organization_id = ?
             AND status = 'active' AND deleted_at IS NULL`,
        )
        .get(accountId, organizationId) as
        { id: string; name: string } | undefined;
      return row ?? null;
    },
  };
}

describe('collaboration direct message kernel', () => {
  it('rejects inactive and cross-organization senders or recipients', () => {
    const database = createDatabase();
    seedAccounts(database);
    const messages = createDirectMessageFacade(createStore(database));

    try {
      expect(() =>
        messages.sendDirectMessage({
          organizationId: 'org-a',
          senderAccountId: 'disabled',
          recipientAccountId: 'bob',
          content: 'disabled sender',
        }),
      ).toThrow('sender account is not active in organization');
      expect(() =>
        messages.sendDirectMessage({
          organizationId: 'org-a',
          senderAccountId: 'alice',
          recipientAccountId: 'mallory',
          content: 'cross tenant',
        }),
      ).toThrow('接收成员不存在或已停用');
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM direct_messages').get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('keeps unread polling read-only and marks only inbound peer messages', () => {
    const database = createDatabase();
    seedAccounts(database);
    const messages = createDirectMessageFacade(createStore(database));

    try {
      const inbound = messages.sendDirectMessage({
        organizationId: 'org-a',
        senderAccountId: 'alice',
        recipientAccountId: 'bob',
        content: 'hello bob',
      });
      const outbound = messages.sendDirectMessage({
        organizationId: 'org-a',
        senderAccountId: 'bob',
        recipientAccountId: 'alice',
        content: 'hello alice',
      });

      expect(
        messages.listUnreadDirectMessageNotifications({
          organizationId: 'org-a',
          accountId: 'bob',
          limit: Number.NaN,
        }),
      ).toMatchObject([{ id: inbound.id, senderAccountId: 'alice' }]);
      expect(
        database
          .prepare('SELECT read_at FROM direct_messages WHERE id = ?')
          .get(inbound.id),
      ).toEqual({ read_at: null });

      expect(
        messages.listDirectMessages({
          organizationId: 'org-a',
          accountId: 'bob',
          peerAccountId: 'alice',
          limit: Number.NaN,
        }),
      ).toHaveLength(2);
      expect(
        database
          .prepare('SELECT id, read_at FROM direct_messages ORDER BY id')
          .all(),
      ).toEqual([
        { id: inbound.id, read_at: expect.any(String) },
        { id: outbound.id, read_at: null },
      ]);
    } finally {
      database.close();
    }
  });

  it('allows only active conversation participants to download attachments', () => {
    const database = createDatabase();
    seedAccounts(database);
    const messages = createDirectMessageFacade(createStore(database));

    try {
      const content = Buffer.from('attachment body', 'utf8');
      const message = messages.sendDirectMessage({
        organizationId: 'org-a',
        senderAccountId: 'alice',
        recipientAccountId: 'bob',
        content: '',
        attachments: [
          {
            fileName: '../report?.txt',
            mimeType: 'application/octet-stream',
            size: content.length,
            data: content.toString('base64'),
          },
        ],
      });
      const attachmentId = message.attachments[0]!.id;
      expect(
        messages.getDirectMessageAttachment({
          organizationId: 'org-a',
          accountId: 'alice',
          attachmentId,
        }),
      ).toMatchObject({
        id: attachmentId,
        fileName: 'report_.txt',
        mimeType: 'text/plain',
        data: content.toString('base64'),
      });
      expect(() =>
        messages.getDirectMessageAttachment({
          organizationId: 'org-a',
          accountId: 'carol',
          attachmentId,
        }),
      ).toThrow('附件不存在或无权访问');
      expect(() =>
        messages.getDirectMessageAttachment({
          organizationId: 'org-b',
          accountId: 'mallory',
          attachmentId,
        }),
      ).toThrow('附件不存在或无权访问');
    } finally {
      database.close();
    }
  });

  it('matches A2A replies by tenant, direction, request id and protocol body', () => {
    const database = createDatabase();
    seedAccounts(database);
    const messages = createDirectMessageFacade(createStore(database));

    try {
      const request = messages.sendDirectMessage({
        organizationId: 'org-a',
        senderAccountId: 'alice',
        recipientAccountId: 'bob',
        content: `${REQUEST_PREFIX}${JSON.stringify({ question: '有空吗？' })}`,
      });
      expect(
        messages.listPendingAtoaRequests({
          organizationId: 'org-a',
          accountId: 'bob',
          requestPrefix: REQUEST_PREFIX,
          responsePrefix: RESPONSE_PREFIX,
        }),
      ).toMatchObject([{ id: request.id, peerAccountId: 'alice' }]);

      const responseContent = `${RESPONSE_PREFIX}${JSON.stringify({
        v: 1,
        requestId: request.id,
        question: '有空吗？',
        answer: '下午三点后有空。',
        createdAt: new Date().toISOString(),
        mode: 'answer',
        grantedSources: ['schedules'],
      })}`;
      messages.sendDirectMessage({
        organizationId: 'org-a',
        senderAccountId: 'bob',
        recipientAccountId: 'alice',
        content: responseContent,
      });
      expect(
        messages.markAtoaRequestReadFromResponse({
          organizationId: 'org-a',
          responderAccountId: 'bob',
          peerAccountId: 'carol',
          responseContent,
          requestPrefix: REQUEST_PREFIX,
          responsePrefix: RESPONSE_PREFIX,
        }),
      ).toBeNull();
      expect(
        database
          .prepare('SELECT read_at FROM direct_messages WHERE id = ?')
          .get(request.id),
      ).toEqual({ read_at: null });
      expect(
        messages.markAtoaRequestReadFromResponse({
          organizationId: 'org-a',
          responderAccountId: 'bob',
          peerAccountId: 'alice',
          responseContent,
          requestPrefix: REQUEST_PREFIX,
          responsePrefix: RESPONSE_PREFIX,
        }),
      ).toBe(request.id);
      expect(
        messages.listPendingAtoaRequests({
          organizationId: 'org-a',
          accountId: 'bob',
          requestPrefix: REQUEST_PREFIX,
          responsePrefix: RESPONSE_PREFIX,
        }),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });
});
