/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database, type EncryptedObjectStore } from './modules/data_platform/index.js';
import {
  DATA_GOVERNANCE_SCHEMA_CONTRIBUTOR,
  createPrivacyDeletionLedger,
  deleteOwnAccountDataInRepository,
  exportAccountDataFromRepository,
  getDataGovernanceProfileFromRepository,
  recordCurrentLegalConsentInRepository,
  type DataGovernanceAccount,
  type DataGovernanceRepositoryStore,
} from './modules/data_governance/index.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture() {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE employees (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT, department TEXT, department_id TEXT, position_id TEXT,
      position_title TEXT, invite_code TEXT, personality TEXT, status TEXT,
      offboarded_at TEXT
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, account_type TEXT NOT NULL,
      employee_id TEXT, username TEXT UNIQUE, phone TEXT, feishu_open_id TEXT,
      password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT, department TEXT,
      department_id TEXT, position_id TEXT, position_title TEXT, avatar_url TEXT,
      is_admin INTEGER NOT NULL, status TEXT NOT NULL, deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE account_tags (account_id TEXT, organization_id TEXT, tag TEXT, created_at TEXT);
    CREATE TABLE auth_sessions (id TEXT, account_id TEXT, revoked_at TEXT);
    CREATE TABLE sms_login_challenges (id TEXT, account_id TEXT);
    CREATE TABLE account_sync_snapshots (
      account_id TEXT, scope TEXT, version INTEGER DEFAULT 1,
      payload_hash TEXT DEFAULT 'hash', device_id TEXT, updated_at_ms INTEGER DEFAULT 1
    );
    CREATE TABLE task_logs (
      employee_id TEXT, task_type TEXT DEFAULT 'agent', context TEXT, result TEXT,
      duration_min REAL, tokens_used INTEGER, cost_cny REAL, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE account_token_usage (
      account_id TEXT, session_id TEXT DEFAULT 'session', message_id TEXT DEFAULT 'message',
      model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE account_presence (account_id TEXT);
    CREATE TABLE direct_messages (
      id TEXT PRIMARY KEY, organization_id TEXT, sender_account_id TEXT,
      recipient_account_id TEXT, content TEXT, created_at TEXT, read_at TEXT
    );
    CREATE TABLE direct_message_attachments (
      id TEXT, message_id TEXT, file_name TEXT, mime_type TEXT, byte_size INTEGER,
      storage_backend TEXT, storage_key TEXT,
      FOREIGN KEY (message_id) REFERENCES direct_messages(id) ON DELETE CASCADE
    );
    CREATE TABLE park_publication_recipients (account_id TEXT);
    CREATE TABLE park_service_specialists (account_id TEXT);
    CREATE TABLE ticket_deliveries (account_id TEXT);
    CREATE TABLE ticket_notifications (recipient_account_id TEXT);
    CREATE TABLE ticket_events (actor_account_id TEXT, response_text TEXT);
    CREATE TABLE it_tickets (
      id TEXT PRIMARY KEY, organization_id TEXT, park_id TEXT, application_number TEXT,
      created_by_account_id TEXT,
      service_id TEXT, title TEXT, description TEXT, form_data TEXT, category TEXT,
      location TEXT, urgency TEXT, contact TEXT, contact_phone TEXT,
      response_type TEXT, response_text TEXT, status TEXT DEFAULT '待接单',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT
    );
    CREATE TABLE knowledge (organization_id TEXT, contributor TEXT);
    CREATE TABLE credit_transactions (account_id TEXT, description TEXT);
    CREATE TABLE audit_logs (employee_id TEXT, detail TEXT);
    INSERT INTO organizations VALUES ('org-a');
    INSERT INTO employees VALUES (
      'emp-a','org-a','王小明','工程师','研发',NULL,NULL,NULL,'INVITE','profile','active',NULL
    );
    INSERT INTO accounts VALUES (
      'acc-a','org-a','enterprise','emp-a','xiaoming','+8613800138000','ou_a',
      'hash','王小明','工程师','研发',NULL,NULL,NULL,'https://avatar',0,'active',NULL,
      datetime('now'),datetime('now')
    );
    INSERT INTO accounts VALUES (
      'acc-b','org-a','enterprise',NULL,'peer',NULL,NULL,'hash','同事',NULL,NULL,
      NULL,NULL,NULL,NULL,1,'active',NULL,datetime('now'),datetime('now')
    );
    INSERT INTO account_tags VALUES ('acc-a','org-a','维修',datetime('now'));
    INSERT INTO auth_sessions VALUES ('session-a','acc-a',NULL);
    INSERT INTO sms_login_challenges VALUES ('sms-a','acc-a');
    INSERT INTO account_sync_snapshots (account_id, scope) VALUES ('acc-a','personal_memory');
    INSERT INTO task_logs (employee_id, context, result) VALUES ('emp-a','private context','private result');
    INSERT INTO account_token_usage (account_id, total_tokens) VALUES ('acc-a',120);
    INSERT INTO account_presence VALUES ('acc-a');
    INSERT INTO direct_messages VALUES ('msg-a','org-a','acc-a','acc-b','私聊内容',datetime('now'),NULL);
    INSERT INTO direct_message_attachments VALUES ('att-a','msg-a','合同.pdf','application/pdf',12,'encrypted-filesystem','aa/bb/object');
    INSERT INTO it_tickets VALUES (
      'ticket-a','org-a',NULL,'20260729001','acc-a','parking','王小明停车申请','联系电话 13800138000',
      '{"companyName":"星河科技","contact":"王小明","phone":"13800138000","amountCny":"260","date":"2026-07-29"}',
      '停车','A-101','普通','王小明','13800138000','现场','已联系王小明','待接单',datetime('now'),datetime('now')
    );
    INSERT INTO knowledge VALUES ('org-a','王小明');
    INSERT INTO credit_transactions VALUES ('acc-a','王小明充值');
    INSERT INTO audit_logs VALUES ('emp-a','Account xiaoming logged in');
  `);
  DATA_GOVERNANCE_SCHEMA_CONTRIBUTOR.apply(database);
  const deletedObjects: string[] = [];
  const tombstones: Array<{ accountId: string; organizationId: string; requestedAtMs: number }> = [];
  const store: DataGovernanceRepositoryStore = {
    db: () => database,
    now: () => Date.parse('2026-07-29T10:00:00.000Z'),
    createId: () => 'request-a',
    createDeletionPasswordHash: () => 'deleted-hash',
    attachmentObjectStore: { delete: (key: string) => deletedObjects.push(key) } as unknown as EncryptedObjectStore,
    appendDeletionTombstone: (entry) => tombstones.push(entry),
  };
  const account: DataGovernanceAccount = {
    id: 'acc-a', organizationId: 'org-a', accountType: 'enterprise', employeeId: 'emp-a',
    username: 'xiaoming', name: '王小明', isAdmin: false, status: 'active',
  };
  return { database, store, account, deletedObjects, tombstones };
}

describe('data_governance consent, export and deletion', () => {
  it('records versioned consent and exports only account-readable fields', () => {
    const fixture = createFixture();
    recordCurrentLegalConsentInRepository(fixture.store, fixture.account, 'settings');
    expect(getDataGovernanceProfileFromRepository(fixture.store, fixture.account))
      .toMatchObject({ currentConsentComplete: true });
    const exported = exportAccountDataFromRepository(fixture.store, fixture.account) as {
      account: Record<string, unknown>;
      messages: Array<{ content: string }>;
    };
    expect(exported.account.password_hash).toBeUndefined();
    expect(exported.messages).toEqual([expect.objectContaining({ content: '私聊内容' })]);
  });

  it('deletes personal content, anonymizes business records and emits a receipt', () => {
    const fixture = createFixture();
    const receipt = deleteOwnAccountDataInRepository(fixture.store, fixture.account);
    expect(receipt.deleted).toContain('本人私聊及附件');
    expect(fixture.tombstones).toEqual([expect.objectContaining({ accountId: 'acc-a' })]);
    expect(fixture.deletedObjects).toEqual(['aa/bb/object']);
    const account = fixture.database.prepare('SELECT * FROM accounts WHERE id = ?').get('acc-a') as Record<string, unknown>;
    expect(account).toMatchObject({ username: 'deleted_acc-a', phone: null, name: '已删除账号', status: 'disabled' });
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM direct_messages').get()).toEqual({ count: 0 });
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM account_sync_snapshots').get()).toEqual({ count: 0 });
    const ticket = fixture.database.prepare('SELECT * FROM it_tickets WHERE id = ?').get('ticket-a') as { form_data: string; contact: string | null };
    expect(ticket.contact).toBeNull();
    expect(JSON.parse(ticket.form_data)).toEqual({ amountCny: '260', date: '2026-07-29', privacyScrubbed: true });
  });
});

describe('encrypted privacy deletion ledger', () => {
  it('survives database backup replacement without exposing account ids in plaintext', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-privacy-ledger-'));
    temporaryDirectories.push(directory);
    const ledgerPath = path.join(directory, 'privacy-deletions.jsonl');
    const ledger = createPrivacyDeletionLedger({ ledgerPath, keyPath: path.join(directory, 'privacy-deletions.key') });
    ledger.append({ accountId: 'acc-secret', organizationId: 'org-secret', requestedAtMs: 123 });
    expect(fs.readFileSync(ledgerPath, 'utf8')).not.toContain('acc-secret');
    expect(ledger.list()).toEqual([{ accountId: 'acc-secret', organizationId: 'org-secret', requestedAtMs: 123 }]);
  });
});
