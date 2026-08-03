/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from '../../modules/data_platform/index.js';
import { buildRedactedDiagnosticPackage } from '../data_governance/index.js';
import type { DataGovernanceRepositoryStore } from '../data_governance/index.js';

function createStore(seed: (database: Database) => void = () => {}): DataGovernanceRepositoryStore {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE employees (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT, department TEXT, status TEXT, invite_code TEXT, personality TEXT
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, account_type TEXT NOT NULL,
      employee_id TEXT, username TEXT UNIQUE, phone TEXT, feishu_open_id TEXT,
      password_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT, department TEXT,
      department_id TEXT, position_id TEXT, position_title TEXT, avatar_url TEXT,
      is_admin INTEGER NOT NULL, status TEXT NOT NULL, deleted_at TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE direct_messages (
      id TEXT PRIMARY KEY, organization_id TEXT, sender_account_id TEXT,
      recipient_account_id TEXT, content TEXT, created_at TEXT, read_at TEXT
    );
    CREATE TABLE direct_message_attachments (
      id TEXT, message_id TEXT, file_name TEXT, mime_type TEXT, byte_size INTEGER,
      storage_backend TEXT, storage_key TEXT
    );
    CREATE TABLE it_tickets (
      id TEXT PRIMARY KEY, organization_id TEXT, created_by_account_id TEXT,
      title TEXT, description TEXT, form_data TEXT, contact TEXT, contact_phone TEXT,
      status TEXT
    );
    CREATE TABLE enterprise_skills (
      id TEXT PRIMARY KEY, organization_id TEXT, author_account_id TEXT,
      name TEXT, status TEXT
    );
    CREATE TABLE knowledge (organization_id TEXT, contributor TEXT, contributor_account_id TEXT);
    CREATE TABLE legal_consents (
      account_id TEXT, organization_id TEXT, document_id TEXT,
      document_version TEXT, policy_hash TEXT, source TEXT, accepted_at_ms INTEGER
    );
    CREATE TABLE privacy_requests (
      id TEXT PRIMARY KEY, account_id TEXT, organization_id TEXT,
      request_type TEXT, status TEXT, requested_at_ms INTEGER
    );
    CREATE TABLE account_token_usage (
      account_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      total_tokens INTEGER, created_at TEXT
    );
    CREATE TABLE task_logs (
      employee_id TEXT, task_type TEXT, context TEXT, result TEXT,
      duration_min REAL, tokens_used INTEGER, cost_cny REAL, created_at TEXT
    );
    CREATE TABLE audit_logs (employee_id TEXT, detail TEXT);
  `);
  seed(database);
  return {
    db: () => database,
    now: () => 1_700_000_000_000,
    createId: () => `id_${Math.random().toString(36).slice(2)}`,
    createDeletionPasswordHash: () => 'hash',
  };
}

describe('buildRedactedDiagnosticPackage', () => {
  it('返回默认脱敏的诊断包，schemaVersion 为 1', () => {
    const store = createStore();
    const pack = buildRedactedDiagnosticPackage(store);
    expect(pack.schemaVersion).toBe(1);
    expect(typeof pack.generatedAt).toBe('string');
    expect(pack.redaction.applied).toBe(true);
  });

  it('配置段来自 dataGovernanceConfiguration（含控制方与保留期限）', () => {
    const store = createStore();
    const pack = buildRedactedDiagnosticPackage(store);
    expect(pack.configuration.retention.securityAuditMinimumDays).toBeGreaterThanOrEqual(180);
    expect(pack.configuration.security.publicTransport).toBe('HTTPS/TLS required');
    expect(Array.isArray(pack.configuration.security.encryptedData)).toBe(true);
  });

  it('处理目录包含数据处理活动清单', () => {
    const store = createStore();
    const pack = buildRedactedDiagnosticPackage(store);
    expect(pack.processingActivities.length).toBeGreaterThan(0);
    expect(pack.processingActivities[0]).toHaveProperty('category');
    expect(pack.processingActivities[0]).toHaveProperty('sensitivity');
    expect(pack.processingActivities[0]).toHaveProperty('retention');
  });

  it('法律文档段带版本与哈希', () => {
    const store = createStore();
    const pack = buildRedactedDiagnosticPackage(store);
    expect(pack.legalDocuments.length).toBeGreaterThanOrEqual(2);
    for (const document of pack.legalDocuments) {
      expect(document.id).toBeTruthy();
      expect(document.version).toBeTruthy();
      expect(document.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('健康段统计各实体数量', () => {
    const store = createStore((database) => {
      database.prepare('INSERT INTO organizations (id) VALUES (?)').run('org-1');
      database.prepare(
        `INSERT INTO accounts (id, organization_id, account_type, password_hash, name, is_admin, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('acct-1', 'org-1', 'enterprise', 'ph', 'Alice', 1, 'active');
      database.prepare(
        `INSERT INTO accounts (id, organization_id, account_type, password_hash, name, is_admin, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('acct-2', 'org-1', 'enterprise', 'ph', 'Bob', 0, 'active');
      database.prepare(
        `INSERT INTO direct_messages (id, organization_id, sender_account_id, recipient_account_id, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('m1', 'org-1', 'acct-1', 'acct-2', '机密聊天原文内容', '2026-01-01');
    });
    const pack = buildRedactedDiagnosticPackage(store);
    expect(pack.health.counts.organizations).toBe(1);
    expect(pack.health.counts.accounts).toBe(2);
    expect(pack.health.counts.activeAccounts).toBe(2);
    expect(pack.health.counts.admins).toBe(1);
    expect(pack.health.counts.directMessages).toBe(1);
    expect(pack.health.counts.messageAttachments).toBe(0);
  });

  it('诊断包不含聊天原文——content 绝不进入输出', () => {
    const store = createStore((database) => {
      database.prepare(
        `INSERT INTO direct_messages (id, organization_id, sender_account_id, recipient_account_id, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('m1', 'org-1', 'a', 'b', '除非机密内容永远不能出现在诊断包里', '2026-01-01');
    });
    const pack = buildRedactedDiagnosticPackage(store);
    const serialized = JSON.stringify(pack);
    expect(serialized).not.toContain('除非机密内容永远不能出现在诊断包里');
    // 只含计数，无 message 数组。
    expect(pack.health.indicators.containsChatContent).toBe(false);
  });

  it('不含个人可识别字段值', () => {
    const store = createStore((database) => {
      database.prepare('INSERT INTO organizations (id) VALUES (?)').run('org-1');
      database.prepare(
        `INSERT INTO accounts (id, organization_id, account_type, username, phone, feishu_open_id,
           password_hash, name, is_admin, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'acct-1', 'org-1', 'enterprise', 'real_username_123', '13800000000',
        'ou_feishu_abc', 'ph', 'Real Person Name', 1, 'active',
      );
    });
    const pack = buildRedactedDiagnosticPackage(store);
    const serialized = JSON.stringify(pack);
    expect(serialized).not.toContain('real_username_123');
    expect(serialized).not.toContain('13800000000');
    expect(serialized).not.toContain('ou_feishu_abc');
    expect(serialized).not.toContain('Real Person Name');
  });

  it('脱敏清单明确列出「聊天原文」排除项', () => {
    const store = createStore();
    const pack = buildRedactedDiagnosticPackage(store);
    const excluded = pack.redaction.excluded.map((item) => item.data);
    expect(excluded).toContain('direct_messages.content');
    expect(pack.redaction.excluded.some((item) => item.data.includes('username'))).toBe(true);
    expect(typeof pack.redaction.note).toBe('string');
    expect(pack.redaction.note.length).toBeGreaterThan(0);
  });

  it('字段加密能力状态进入指标', () => {
    const store = createStore();
    const pack = buildRedactedDiagnosticPackage(store);
    // 未配置 fieldCipher 时，消息加密标记为 false。
    expect(pack.health.indicators.messageFieldsEncrypted).toBe(false);
  });
});
