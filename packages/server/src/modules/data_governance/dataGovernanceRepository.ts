/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  Database,
  EncryptedFieldCipher,
  EncryptedObjectStore,
} from '../data_platform/index.js';
import {
  CURRENT_LEGAL_DOCUMENTS,
  dataGovernanceConfiguration,
  dataProcessingInventory,
  legalDocumentHash,
  requireCurrentLegalDocumentReferences,
  type LegalDocumentReference,
} from './legalDocuments.js';
import type { PrivacyDeletionTombstone } from './privacyDeletionLedger.js';

export interface DataGovernanceAccount {
  id: string;
  organizationId: string;
  accountType: 'personal' | 'enterprise';
  employeeId: string | null;
  username: string;
  name: string;
  isAdmin: boolean;
  status: 'active' | 'disabled';
}

export interface DataGovernanceRepositoryStore {
  db(): Database;
  now(): number;
  createId(): string;
  createDeletionPasswordHash(): string;
  fieldCipher?: EncryptedFieldCipher;
  attachmentObjectStore?: EncryptedObjectStore;
  appendDeletionTombstone(entry: PrivacyDeletionTombstone): void;
}

export interface PrivacyDeletionReceipt {
  requestId: string;
  accountId: string;
  organizationId: string;
  completedAt: string;
  deleted: string[];
  anonymized: string[];
  retained: Array<{ category: string; reason: string; restriction: string }>;
  backupExpiry: string;
}

function tableExists(database: Database, table: string): boolean {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function rows<T>(database: Database, table: string, sql: string, ...params: unknown[]): T[] {
  return tableExists(database, table)
    ? database.prepare(sql).all(...params) as T[]
    : [];
}

function runIfTable(database: Database, table: string, sql: string, ...params: unknown[]): void {
  if (tableExists(database, table)) database.prepare(sql).run(...params);
}

function retainedTicketFormData(raw: string | null): string {
  const allowed = new Set([
    'amountCny', 'recurringMonthlyCny', 'quantity', 'billingUnit', 'pricing',
    'applicationType', 'businessType', 'date', 'startDate', 'expectedDate',
    'visitDate', 'startTime', 'endTime', 'time', 'roomId', 'chargingKwh',
    'unitPriceCny', 'vehicleCount',
  ]);
  try {
    const value = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return JSON.stringify({
      ...Object.fromEntries(Object.entries(value).filter(([key, item]) => (
        allowed.has(key) && (typeof item === 'string' || typeof item === 'number')
      ))),
      privacyScrubbed: true,
    });
  } catch {
    return JSON.stringify({ privacyScrubbed: true });
  }
}

function exportedDirectMessages(
  store: DataGovernanceRepositoryStore,
  account: DataGovernanceAccount,
): Array<Record<string, unknown>> {
  const database = store.db();
  const sharedWhere = `FROM direct_messages WHERE organization_id = ?
    AND (sender_account_id = ? OR recipient_account_id = ?) ORDER BY created_at`;
  if (!store.fieldCipher) {
    return rows<Record<string, unknown>>(
      database,
      'direct_messages',
      `SELECT id, sender_account_id, recipient_account_id, content, created_at, read_at
       ${sharedWhere}`,
      account.organizationId,
      account.id,
      account.id,
    );
  }
  const encryptedRows = rows<{
    id: string;
    organization_id: string;
    sender_account_id: string;
    recipient_account_id: string;
    content: string;
    content_ciphertext: string | null;
    content_iv: string | null;
    content_auth_tag: string | null;
    content_key_version: number | null;
    created_at: string;
    read_at: string | null;
  }>(
    database,
    'direct_messages',
    `SELECT id, organization_id, sender_account_id, recipient_account_id,
            content, content_ciphertext, content_iv, content_auth_tag,
            content_key_version, created_at, read_at
     ${sharedWhere}`,
    account.organizationId,
    account.id,
    account.id,
  );
  return encryptedRows.map((row) => ({
    id: row.id,
    sender_account_id: row.sender_account_id,
    recipient_account_id: row.recipient_account_id,
    content: row.content_ciphertext
      ? store.fieldCipher!.decryptText({
        ciphertext: row.content_ciphertext,
        iv: row.content_iv || '',
        authTag: row.content_auth_tag || '',
        keyVersion: Number(row.content_key_version),
      }, `direct-message:${row.organization_id}:${row.id}`)
      : row.content,
    created_at: row.created_at,
    read_at: row.read_at,
  }));
}

export function recordCurrentLegalConsentInRepository(
  store: DataGovernanceRepositoryStore,
  account: DataGovernanceAccount,
  source: 'registration' | 'settings' | 'migration',
  references: readonly LegalDocumentReference[],
): void {
  requireCurrentLegalDocumentReferences(references);
  const acceptedAtMs = store.now();
  const insert = store.db().prepare(
    `INSERT INTO legal_consents
       (account_id, organization_id, document_id, document_version,
        policy_hash, source, accepted_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, document_id, document_version) DO NOTHING`,
  );
  for (const document of CURRENT_LEGAL_DOCUMENTS) {
    insert.run(
      account.id,
      account.organizationId,
      document.id,
      document.version,
      legalDocumentHash(document),
      source,
      acceptedAtMs,
    );
  }
}

export function getDataGovernanceProfileFromRepository(
  store: DataGovernanceRepositoryStore,
  account?: DataGovernanceAccount | null,
) {
  const accepted = account
    ? rows<{
      document_id: string;
      document_version: string;
      policy_hash: string;
      accepted_at_ms: number;
    }>(
      store.db(),
      'legal_consents',
      `SELECT document_id, document_version, policy_hash, accepted_at_ms
       FROM legal_consents WHERE account_id = ?`,
      account.id,
    )
    : [];
  const documents = CURRENT_LEGAL_DOCUMENTS.map((document) => {
    const hash = legalDocumentHash(document);
    const consent = accepted.find((row) => (
      row.document_id === document.id
      && row.document_version === document.version
      && row.policy_hash === hash
    ));
    return {
      ...document,
      hash,
      accepted: Boolean(consent),
      acceptedAt: consent?.accepted_at_ms ?? null,
    };
  });
  return {
    ...dataGovernanceConfiguration(),
    documents,
    processingActivities: dataProcessingInventory(),
    rights: [
      '查看个人信息处理规则和数据处理目录',
      '访问、更正、复制和导出本人数据',
      '撤回可选处理同意',
      '注销账号并删除或匿名化个人数据',
      '向部署方隐私联系人投诉或咨询',
    ],
    currentConsentComplete: account
      ? documents.every((document) => document.accepted)
      : false,
  };
}

export function exportAccountDataFromRepository(
  store: DataGovernanceRepositoryStore,
  account: DataGovernanceAccount,
) {
  const database = store.db();
  const requestId = `privacy_${store.createId()}`;
  const requestedAtMs = store.now();
  database.prepare(
    `INSERT INTO privacy_requests
       (id, account_id, organization_id, request_type, status, requested_at_ms)
     VALUES (?, ?, ?, 'export', 'requested', ?)`,
  ).run(requestId, account.id, account.organizationId, requestedAtMs);
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date(requestedAtMs).toISOString(),
    requestId,
    account: rows<Record<string, unknown>>(
      database, 'accounts',
      `SELECT id, organization_id, account_type, employee_id, username, phone,
              feishu_open_id, name, role, department, department_id, position_id,
              position_title, avatar_url, is_admin, status, created_at, updated_at
       FROM accounts WHERE id = ? AND organization_id = ?`,
      account.id, account.organizationId,
    )[0] ?? null,
    employee: account.employeeId
      ? rows<Record<string, unknown>>(database, 'employees', 'SELECT * FROM employees WHERE id = ?', account.employeeId)[0] ?? null
      : null,
    tags: rows<Record<string, unknown>>(database, 'account_tags', 'SELECT tag, created_at FROM account_tags WHERE account_id = ?', account.id),
    legalConsents: rows<Record<string, unknown>>(database, 'legal_consents', 'SELECT document_id, document_version, policy_hash, source, accepted_at_ms FROM legal_consents WHERE account_id = ?', account.id),
    accountSyncSnapshots: rows<Record<string, unknown>>(database, 'account_sync_snapshots', 'SELECT scope, version, payload_hash, device_id, updated_at_ms FROM account_sync_snapshots WHERE account_id = ?', account.id),
    worklogs: account.employeeId
      ? rows<Record<string, unknown>>(database, 'task_logs', 'SELECT task_type, context, result, duration_min, tokens_used, cost_cny, created_at FROM task_logs WHERE employee_id = ? ORDER BY created_at', account.employeeId)
      : [],
    modelUsage: rows<Record<string, unknown>>(database, 'account_token_usage', 'SELECT session_id, message_id, model, input_tokens, output_tokens, total_tokens, created_at FROM account_token_usage WHERE account_id = ? ORDER BY created_at', account.id),
    sharedSkills: rows<Record<string, unknown>>(
      database,
      'enterprise_skills',
      `SELECT id, name, description, department, visibility, status, version,
              install_count, usage_count, success_count, failure_count,
              rating_count, created_at, updated_at
       FROM enterprise_skills WHERE organization_id = ? AND author_account_id = ?
       ORDER BY created_at`,
      account.organizationId,
      account.id,
    ),
    skillInstalls: rows<Record<string, unknown>>(
      database,
      'enterprise_skill_installs',
      `SELECT skill_id, installed_version, installed_at, updated_at
       FROM enterprise_skill_installs WHERE organization_id = ? AND account_id = ?`,
      account.organizationId,
      account.id,
    ),
    skillRatings: rows<Record<string, unknown>>(
      database,
      'enterprise_skill_ratings',
      `SELECT skill_id, score, created_at, updated_at
       FROM enterprise_skill_ratings WHERE organization_id = ? AND account_id = ?`,
      account.organizationId,
      account.id,
    ),
    skillUsageEvidence: rows<Record<string, unknown>>(
      database,
      'enterprise_skill_usage_events',
      `SELECT skill_id, success, created_at FROM enterprise_skill_usage_events
       WHERE organization_id = ? AND account_id = ? ORDER BY created_at`,
      account.organizationId,
      account.id,
    ),
    messages: exportedDirectMessages(store, account),
    messageAttachments: rows<Record<string, unknown>>(
      database, 'direct_message_attachments',
      `SELECT a.id, a.message_id, a.file_name, a.mime_type, a.byte_size
       FROM direct_message_attachments a JOIN direct_messages m ON m.id = a.message_id
       WHERE m.organization_id = ? AND (m.sender_account_id = ? OR m.recipient_account_id = ?)`,
      account.organizationId, account.id, account.id,
    ),
    parkServiceRequests: rows<Record<string, unknown>>(
      database, 'it_tickets',
      `SELECT id, park_id, application_number, service_id, title, description,
              form_data, category, location, urgency, contact, contact_phone,
              response_type, response_text, status, created_at, updated_at
       FROM it_tickets WHERE organization_id = ? AND created_by_account_id = ?
       ORDER BY created_at`,
      account.organizationId, account.id,
    ),
  };
  database.prepare(
    `UPDATE privacy_requests SET status = 'completed', completed_at_ms = ?, receipt_json = ?
     WHERE id = ?`,
  ).run(store.now(), JSON.stringify({ categories: Object.keys(payload) }), requestId);
  return payload;
}

function scrubAccountData(
  store: DataGovernanceRepositoryStore,
  accountId: string,
  organizationId: string,
  options: { enforceAdminContinuity: boolean },
): PrivacyDeletionReceipt | null {
  const database = store.db();
  const account = database.prepare(
    `SELECT id, organization_id, account_type, employee_id, username, name,
            is_admin, status, deleted_at
     FROM accounts WHERE id = ? AND organization_id = ?`,
  ).get(accountId, organizationId) as {
    id: string; organization_id: string; account_type: 'personal' | 'enterprise';
    employee_id: string | null; username: string; name: string;
    is_admin: number; status: 'active' | 'disabled'; deleted_at: string | null;
  } | undefined;
  if (!account || account.deleted_at) return null;
  if (options.enforceAdminContinuity && account.account_type === 'enterprise'
      && account.is_admin === 1 && account.status === 'active') {
    const other = database.prepare(
      `SELECT 1 FROM accounts WHERE organization_id = ? AND id <> ?
       AND is_admin = 1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
    ).get(organizationId, accountId);
    if (!other) throw new Error('企业至少需要保留一名可登录管理员');
  }
  const attachmentKeys = rows<{ storage_key: string }>(
    database, 'direct_message_attachments',
    `SELECT a.storage_key FROM direct_message_attachments a
     JOIN direct_messages m ON m.id = a.message_id
     WHERE a.storage_backend = 'encrypted-filesystem' AND a.storage_key IS NOT NULL
       AND m.organization_id = ? AND (m.sender_account_id = ? OR m.recipient_account_id = ?)`,
    organizationId, accountId, accountId,
  ).map((row) => row.storage_key);
  const ticketRows = rows<{ id: string; form_data: string | null }>(
    database, 'it_tickets',
    'SELECT id, form_data FROM it_tickets WHERE organization_id = ? AND created_by_account_id = ?',
    organizationId, accountId,
  );
  const requestId = `privacy_${store.createId()}`;
  const now = store.now();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(
      `INSERT INTO privacy_requests
         (id, account_id, organization_id, request_type, status, requested_at_ms)
       VALUES (?, ?, ?, 'delete', 'requested', ?)`,
    ).run(requestId, accountId, organizationId, now);
    runIfTable(database, 'account_sync_snapshots', 'DELETE FROM account_sync_snapshots WHERE account_id = ?', accountId);
    if (account.employee_id) runIfTable(database, 'task_logs', 'DELETE FROM task_logs WHERE employee_id = ?', account.employee_id);
    runIfTable(database, 'account_token_usage', 'DELETE FROM account_token_usage WHERE account_id = ?', accountId);
    runIfTable(database, 'account_presence', 'DELETE FROM account_presence WHERE account_id = ?', accountId);
    runIfTable(database, 'enterprise_skill_ratings', 'DELETE FROM enterprise_skill_ratings WHERE account_id = ?', accountId);
    runIfTable(database, 'enterprise_skill_installs', 'DELETE FROM enterprise_skill_installs WHERE account_id = ?', accountId);
    runIfTable(database, 'enterprise_skill_versions', 'UPDATE enterprise_skill_versions SET created_by = NULL WHERE created_by = ?', accountId);
    runIfTable(database, 'enterprise_skill_usage_events', 'UPDATE enterprise_skill_usage_events SET account_id = NULL WHERE account_id = ?', accountId);
    runIfTable(database, 'enterprise_skills', "UPDATE enterprise_skills SET author_account_id = NULL, author_name = '已删除成员' WHERE organization_id = ? AND author_account_id = ?", organizationId, accountId);
    runIfTable(
      database,
      'enterprise_skills',
      `UPDATE enterprise_skills SET
         install_count = (SELECT COUNT(*) FROM enterprise_skill_installs i WHERE i.skill_id = enterprise_skills.id),
         rating_total = (SELECT COALESCE(SUM(score), 0) FROM enterprise_skill_ratings r WHERE r.skill_id = enterprise_skills.id),
         rating_count = (SELECT COUNT(*) FROM enterprise_skill_ratings r WHERE r.skill_id = enterprise_skills.id)
       WHERE organization_id = ?`,
      organizationId,
    );
    runIfTable(database, 'direct_messages', 'DELETE FROM direct_messages WHERE organization_id = ? AND (sender_account_id = ? OR recipient_account_id = ?)', organizationId, accountId, accountId);
    runIfTable(database, 'park_publication_recipients', 'DELETE FROM park_publication_recipients WHERE account_id = ?', accountId);
    runIfTable(database, 'park_service_specialists', 'DELETE FROM park_service_specialists WHERE account_id = ?', accountId);
    runIfTable(database, 'ticket_deliveries', 'DELETE FROM ticket_deliveries WHERE account_id = ?', accountId);
    runIfTable(database, 'ticket_notifications', 'DELETE FROM ticket_notifications WHERE recipient_account_id = ?', accountId);
    runIfTable(database, 'ticket_events', 'UPDATE ticket_events SET actor_account_id = NULL, response_text = NULL WHERE actor_account_id = ?', accountId);
    if (tableExists(database, 'it_tickets')) {
      const updateTicket = database.prepare(
        `UPDATE it_tickets SET title = '已匿名化园区服务记录', description = '',
           form_data = ?, category = NULL, location = NULL, urgency = NULL,
           contact = NULL, contact_phone = NULL, response_type = NULL,
           response_text = NULL, updated_at = datetime('now') WHERE id = ?`,
      );
      for (const ticket of ticketRows) updateTicket.run(retainedTicketFormData(ticket.form_data), ticket.id);
    }
    runIfTable(
      database,
      'knowledge',
      `UPDATE knowledge SET contributor = NULL, contributor_account_id = NULL
       WHERE organization_id = ?
         AND (contributor_account_id = ? OR contributor IN (?, ?, ?))`,
      organizationId,
      accountId,
      accountId,
      account.username,
      account.name,
    );
    runIfTable(
      database,
      'knowledge_retention_evidence',
      `DELETE FROM knowledge_retention_evidence
       WHERE organization_id = ? AND contributor_account_id = ?`,
      organizationId,
      accountId,
    );
    runIfTable(database, 'credit_transactions', "UPDATE credit_transactions SET description = '已匿名化账号交易记录' WHERE account_id = ?", accountId);
    runIfTable(database, 'audit_logs', "UPDATE audit_logs SET employee_id = NULL, detail = '已按账号注销要求脱敏的安全审计记录' WHERE employee_id = ?", account.employee_id);
    runIfTable(database, 'account_tags', 'DELETE FROM account_tags WHERE account_id = ?', accountId);
    runIfTable(database, 'auth_sessions', 'DELETE FROM auth_sessions WHERE account_id = ?', accountId);
    runIfTable(database, 'sms_login_challenges', 'DELETE FROM sms_login_challenges WHERE account_id = ?', accountId);
    if (account.employee_id && tableExists(database, 'employees')) {
      database.prepare(
        `UPDATE employees SET name = '已删除成员', role = NULL, department = NULL,
           department_id = NULL, position_id = NULL, position_title = NULL,
           invite_code = NULL, personality = NULL, status = 'offboarded',
           offboarded_at = datetime('now') WHERE id = ? AND organization_id = ?`,
      ).run(account.employee_id, organizationId);
    }
    database.prepare(
      `UPDATE accounts SET employee_id = NULL, username = ?, phone = NULL,
         feishu_open_id = NULL, password_hash = ?, name = '已删除账号', role = NULL,
         department = NULL, department_id = NULL, position_id = NULL,
         position_title = NULL, avatar_url = NULL, is_admin = 0, status = 'disabled',
         deleted_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND organization_id = ?`,
    ).run(`deleted_${accountId}`, store.createDeletionPasswordHash(), accountId, organizationId);
    const receipt: PrivacyDeletionReceipt = {
      requestId,
      accountId,
      organizationId,
      completedAt: new Date(now).toISOString(),
      deleted: ['会话与验证码', '账号标签', '个人记忆同步快照', '工作日志', 'Token 明细', '在线状态', '本人私聊及附件', '园区消息接收与专员分派', 'Skill 安装及评分身份记录'],
      anonymized: ['账号与员工档案', '园区服务工单', '企业知识贡献者', '企业 Skill 作者', '积分交易说明', '安全审计详情'],
      retained: [
        { category: '园区服务统计', reason: '企业年度服务、金额和履约统计', restriction: '仅保留服务类型、时间、状态、数量和金额，不保留联系人及表单原文' },
        { category: '积分与财务记录', reason: '交易对账和法定义务', restriction: '账号仅以不可登录的匿名标识关联' },
        { category: '安全审计日志', reason: '网络安全与追溯义务', restriction: '至少 180 天内仅限安全、存储和法定义务处理' },
      ],
      backupExpiry: `加密备份默认最长 ${dataGovernanceConfiguration().retention.encryptedBackupDefaultDays} 天；恢复后删除账本会再次清理本人数据`,
    };
    database.prepare(
      `UPDATE privacy_requests SET status = 'completed', completed_at_ms = ?, receipt_json = ?
       WHERE id = ?`,
    ).run(now, JSON.stringify(receipt), requestId);
    database.exec('COMMIT');
    for (const key of attachmentKeys) {
      try { store.attachmentObjectStore?.delete(key); } catch { /* orphan sweep retries */ }
    }
    return receipt;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function deleteOwnAccountDataInRepository(
  store: DataGovernanceRepositoryStore,
  account: DataGovernanceAccount,
): PrivacyDeletionReceipt {
  const entry = { accountId: account.id, organizationId: account.organizationId, requestedAtMs: store.now() };
  if (account.accountType === 'enterprise' && account.isAdmin && account.status === 'active') {
    const other = store.db().prepare(
      `SELECT 1 FROM accounts WHERE organization_id = ? AND id <> ?
       AND is_admin = 1 AND status = 'active' AND deleted_at IS NULL LIMIT 1`,
    ).get(account.organizationId, account.id);
    if (!other) throw new Error('企业至少需要保留一名可登录管理员');
  }
  store.appendDeletionTombstone(entry);
  const receipt = scrubAccountData(store, account.id, account.organizationId, { enforceAdminContinuity: false });
  if (!receipt) throw new Error('账号已注销或不存在');
  return receipt;
}

export function reapplyPrivacyDeletionTombstones(
  store: DataGovernanceRepositoryStore,
  tombstones: readonly PrivacyDeletionTombstone[],
): number {
  let applied = 0;
  for (const tombstone of tombstones) {
    if (scrubAccountData(store, tombstone.accountId, tombstone.organizationId, { enforceAdminContinuity: false })) {
      applied += 1;
    }
  }
  return applied;
}
