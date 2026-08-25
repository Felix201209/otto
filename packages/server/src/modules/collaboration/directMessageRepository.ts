/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  Database,
  EncryptedFieldCipher,
  EncryptedObjectStore,
} from '../data_platform/index.js';

export interface CollaborationActiveAccount {
  id: string;
  name: string;
}

export interface DirectMessageRepositoryStore {
  db(): Database;
  createId(): string;
  fieldCipher?: EncryptedFieldCipher;
  attachmentObjectStore?: EncryptedObjectStore;
  getActiveAccountInOrganization(
    accountId: string,
    organizationId: string,
  ): CollaborationActiveAccount | null;
}

export interface DirectMessageView {
  id: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
  createdAt: string;
  readAt: string | null;
  attachments: DirectMessageAttachmentView[];
}

export const DIRECT_MESSAGE_ATTACHMENT_MAX_COUNT = 6;
export const DIRECT_MESSAGE_ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DIRECT_MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const DIRECT_MESSAGE_ATTACHMENT_MIME_BY_EXTENSION: Readonly<
  Record<string, string>
> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
  '.zip': 'application/zip',
};

export interface DirectMessageAttachmentView {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface DirectMessageAttachmentInput {
  fileName: string;
  mimeType: string;
  size: number;
  data: string;
}

export interface DirectMessageAttachmentDownload extends DirectMessageAttachmentView {
  data: string;
}

export interface AtoaInboxMessageView extends DirectMessageView {
  peerAccountId: string;
}

interface DirectMessageRow {
  id: string;
  organization_id: string;
  sender_account_id: string;
  recipient_account_id: string;
  content: string;
  content_ciphertext?: string | null;
  content_iv?: string | null;
  content_auth_tag?: string | null;
  content_key_version?: number | null;
  content_type?: 'message' | 'atoa_request' | 'atoa_response';
  created_at: string;
  read_at: string | null;
}

function sqliteUtcTimestamp(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(
    trimmed,
  )
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

const ATOA_REQUEST_CONTENT_PREFIX = 'OTTO_ATOA_REQUEST ';
const ATOA_RESPONSE_CONTENT_PREFIX = 'OTTO_ATOA_RESPONSE ';

function directMessageContentType(
  content: string,
): 'message' | 'atoa_request' | 'atoa_response' {
  if (content.startsWith(ATOA_REQUEST_CONTENT_PREFIX)) return 'atoa_request';
  if (content.startsWith(ATOA_RESPONSE_CONTENT_PREFIX)) return 'atoa_response';
  return 'message';
}

interface DirectMessageAttachmentRow {
  id: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
}

interface DirectMessageAttachmentMessageRow extends DirectMessageAttachmentRow {
  message_id: string;
}

interface DirectMessageAttachmentContentRow extends DirectMessageAttachmentRow {
  content: Uint8Array;
  storage_backend: string;
  storage_key: string | null;
}

interface NormalizedDirectMessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  content: Buffer;
}

function normalizeResultLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value!)));
}

function normalizeDirectMessageFileName(value: unknown): {
  fileName: string;
  mimeType: string;
} {
  if (typeof value !== 'string')
    throw new Error('attachment file name is invalid');
  const baseName = path.posix.basename(value.replace(/\\/g, '/')).trim();
  const safeName = Array.from(baseName)
    .map((character) =>
      character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character)
        ? '_'
        : character,
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new Error('attachment file name is invalid');
  }
  const extension = path.extname(safeName).toLowerCase();
  const mimeType = DIRECT_MESSAGE_ATTACHMENT_MIME_BY_EXTENSION[extension];
  if (!mimeType) throw new Error('attachment file type is not supported');
  if (safeName.length <= 180) return { fileName: safeName, mimeType };
  return {
    fileName:
      safeName.slice(0, Math.max(1, 180 - extension.length)) + extension,
    mimeType,
  };
}

function normalizeDirectMessageAttachments(
  attachments: readonly DirectMessageAttachmentInput[] | undefined,
): NormalizedDirectMessageAttachment[] {
  if (attachments == null) return [];
  if (!Array.isArray(attachments))
    throw new Error('attachment metadata is invalid');
  if (attachments.length > DIRECT_MESSAGE_ATTACHMENT_MAX_COUNT) {
    throw new Error('a message can contain at most 6 attachments');
  }
  let totalBytes = 0;
  return attachments.map((attachment) => {
    if (!attachment || typeof attachment !== 'object') {
      throw new Error('attachment metadata is invalid');
    }
    const { fileName, mimeType } = normalizeDirectMessageFileName(
      attachment.fileName,
    );
    if (typeof attachment.data !== 'string')
      throw new Error('attachment data is invalid');
    const data = attachment.data.trim();
    if (
      !data ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        data,
      )
    ) {
      throw new Error('attachment data is invalid');
    }
    const content = Buffer.from(data, 'base64');
    if (!content.length || content.toString('base64') !== data) {
      throw new Error('attachment data is invalid');
    }
    if (
      content.length > DIRECT_MESSAGE_ATTACHMENT_MAX_FILE_BYTES ||
      Number(attachment.size) !== content.length
    ) {
      throw new Error(
        'an attachment must be complete and no larger than 10 MB',
      );
    }
    totalBytes += content.length;
    if (totalBytes > DIRECT_MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES) {
      throw new Error('attachments in one message cannot exceed 20 MB');
    }
    return {
      id: randomUUID(),
      fileName,
      mimeType,
      size: content.length,
      content,
    };
  });
}

function listDirectMessageAttachmentViews(
  database: Database,
  messageId: string,
): DirectMessageAttachmentView[] {
  const rows = database
    .prepare(
      'SELECT id, file_name, mime_type, byte_size ' +
        'FROM direct_message_attachments WHERE message_id = ? ORDER BY ordinal, id',
    )
    .all(messageId) as DirectMessageAttachmentRow[];
  return rows.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: Number(row.byte_size),
  }));
}

function listDirectMessageAttachmentMap(
  database: Database,
  messageIds: readonly string[],
): Map<string, DirectMessageAttachmentView[]> {
  const result = new Map<string, DirectMessageAttachmentView[]>();
  if (messageIds.length === 0) return result;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = database
    .prepare(
      'SELECT message_id, id, file_name, mime_type, byte_size ' +
        'FROM direct_message_attachments WHERE message_id IN (' +
        placeholders +
        ') ' +
        'ORDER BY message_id, ordinal, id',
    )
    .all(...messageIds) as DirectMessageAttachmentMessageRow[];
  for (const row of rows) {
    const attachments = result.get(row.message_id) ?? [];
    attachments.push({
      id: row.id,
      fileName: row.file_name,
      mimeType: row.mime_type,
      size: Number(row.byte_size),
    });
    result.set(row.message_id, attachments);
  }
  return result;
}

function directMessageEncryptionContext(row: Pick<DirectMessageRow, 'id' | 'organization_id'>): string {
  return `direct-message:${row.organization_id}:${row.id}`;
}

export function directMessageContentFromRepository(
  store: Pick<DirectMessageRepositoryStore, 'fieldCipher'>,
  row: DirectMessageRow,
): string {
  const encrypted = row.content_ciphertext;
  if (!encrypted) return row.content;
  if (
    !store.fieldCipher ||
    !row.content_iv ||
    !row.content_auth_tag ||
    row.content_key_version == null
  ) {
    throw new Error('direct message encryption metadata is unavailable');
  }
  return store.fieldCipher.decryptText({
    ciphertext: encrypted,
    iv: row.content_iv,
    authTag: row.content_auth_tag,
    keyVersion: Number(row.content_key_version),
  }, directMessageEncryptionContext(row));
}

function toDirectMessageView(
  store: DirectMessageRepositoryStore,
  row: DirectMessageRow,
  attachments = listDirectMessageAttachmentViews(store.db(), row.id),
): DirectMessageView {
  return {
    id: row.id,
    senderAccountId: row.sender_account_id,
    recipientAccountId: row.recipient_account_id,
    content: directMessageContentFromRepository(store, row),
    createdAt: sqliteUtcTimestamp(row.created_at) ?? row.created_at,
    readAt: sqliteUtcTimestamp(row.read_at),
    attachments,
  };
}

/** Converts legacy plaintext rows in-place after the encryption columns exist. */
export function migrateDirectMessageContentEncryption(
  store: DirectMessageRepositoryStore,
): number {
  if (!store.fieldCipher) return 0;
  const database = store.db();
  const hasE2eeProtocolColumn = (
    database.prepare('PRAGMA table_info(direct_messages)').all() as Array<{
      name: string;
    }>
  ).some((column) => column.name === 'e2ee_protocol_version');
  const selectBatch = database.prepare(
    `SELECT * FROM direct_messages
     WHERE content_ciphertext IS NULL
       ${hasE2eeProtocolColumn ? 'AND e2ee_protocol_version IS NULL' : ''}
     ORDER BY created_at, id
     LIMIT 500`,
  );
  const update = database.prepare(
    `UPDATE direct_messages
     SET content = '[encrypted:v1]', content_ciphertext = ?, content_iv = ?,
         content_auth_tag = ?, content_key_version = ?, content_type = ?
     WHERE id = ? AND organization_id = ? AND content_ciphertext IS NULL`,
  );
  let migrated = 0;
  while (true) {
    const rows = selectBatch.all() as DirectMessageRow[];
    if (rows.length === 0) return migrated;
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const encrypted = store.fieldCipher.encryptText(
          row.content,
          directMessageEncryptionContext(row),
        );
        const result = update.run(
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyVersion,
          directMessageContentType(row.content),
          row.id,
          row.organization_id,
        );
        migrated += Number(result.changes);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

export interface SendDirectMessageInput {
  organizationId: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
  attachments?: DirectMessageAttachmentInput[];
}

export function sendDirectMessageInRepository(
  store: DirectMessageRepositoryStore,
  input: SendDirectMessageInput,
): DirectMessageView {
  const organizationId = input.organizationId.trim();
  const senderAccountId = input.senderAccountId.trim();
  const recipientAccountId = input.recipientAccountId.trim();
  if (!organizationId || !senderAccountId || !recipientAccountId) {
    throw new Error('message organization and participants are required');
  }
  const attachments = normalizeDirectMessageAttachments(input.attachments);
  const trimmedContent = input.content.trim();
  const content =
    trimmedContent ||
    (attachments.length > 0
      ? `Shared ${attachments.length} file(s): ${attachments.map((item) => item.fileName).join(', ')}`
      : '');
  if (!content || content.length > 4000)
    throw new Error('消息内容长度必须为 1 到 4000 个字符');
  if (senderAccountId === recipientAccountId)
    throw new Error('不能给自己发送消息');
  const sender = store.getActiveAccountInOrganization(
    senderAccountId,
    organizationId,
  );
  const recipient = store.getActiveAccountInOrganization(
    recipientAccountId,
    organizationId,
  );
  if (!sender) throw new Error('sender account is not active in organization');
  if (!recipient) throw new Error('接收成员不存在或已停用');
  const id = store.createId();
  const database = store.db();
  const encryptedContent = store.fieldCipher?.encryptText(content, `direct-message:${organizationId}:${id}`);
  const contentType = directMessageContentType(content);
  const storedObjectKeys: string[] = [];
  database.exec('BEGIN IMMEDIATE');
  try {
    if (encryptedContent) {
      database
        .prepare(
          `INSERT INTO direct_messages
        (id, organization_id, sender_account_id, recipient_account_id, content,
         content_ciphertext, content_iv, content_auth_tag, content_key_version,
         content_type)
        VALUES (?, ?, ?, ?, '[encrypted:v1]', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          organizationId,
          senderAccountId,
          recipientAccountId,
          encryptedContent.ciphertext,
          encryptedContent.iv,
          encryptedContent.authTag,
          encryptedContent.keyVersion,
          contentType,
        );
    } else {
      database
        .prepare(
          `INSERT INTO direct_messages
        (id, organization_id, sender_account_id, recipient_account_id, content, content_type)
        VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, organizationId, senderAccountId, recipientAccountId, content, contentType);
    }
    const insertAttachment = database.prepare(
      `INSERT INTO direct_message_attachments
      (id, message_id, organization_id, ordinal, file_name, mime_type, byte_size,
       content, storage_backend, storage_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    attachments.forEach((attachment, index) => {
      const stored = store.attachmentObjectStore?.put({
        namespace: organizationId,
        objectId: attachment.id,
        content: attachment.content,
      });
      if (stored) storedObjectKeys.push(stored.key);
      insertAttachment.run(
        attachment.id,
        id,
        organizationId,
        index,
        attachment.fileName,
        attachment.mimeType,
        attachment.size,
        stored ? Buffer.alloc(0) : attachment.content,
        stored?.backend ?? 'sqlite',
        stored?.key ?? null,
      );
    });
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* preserve original error */
    }
    for (const key of storedObjectKeys) {
      try {
        store.attachmentObjectStore?.delete(key);
      } catch {
        // A later orphan sweep removes an object that could not be cleaned up.
      }
    }
    throw error;
  }
  for (const key of storedObjectKeys) {
    try {
      store.attachmentObjectStore?.markCommitted(key);
    } catch {
      // The committed database reference remains authoritative and protects it.
    }
  }
  const row = database
    .prepare('SELECT * FROM direct_messages WHERE id = ?')
    .get(id) as DirectMessageRow;
  return toDirectMessageView(store, row);
}

export interface ListDirectMessagesInput {
  organizationId: string;
  accountId: string;
  peerAccountId: string;
  limit?: number;
}

export function listDirectMessagesFromRepository(
  store: DirectMessageRepositoryStore,
  input: ListDirectMessagesInput,
): DirectMessageView[] {
  const organizationId = input.organizationId.trim();
  const accountId = input.accountId.trim();
  const peerAccountId = input.peerAccountId.trim();
  if (
    !store.getActiveAccountInOrganization(accountId, organizationId) ||
    !store.getActiveAccountInOrganization(peerAccountId, organizationId)
  ) {
    throw new Error('message participant is not active in organization');
  }
  const limit = normalizeResultLimit(input.limit, 100, 200);
  const database = store.db();
  database
    .prepare(
      `UPDATE direct_messages SET read_at = COALESCE(read_at, datetime('now'))
     WHERE organization_id = ? AND sender_account_id = ? AND recipient_account_id = ?`,
    )
    .run(organizationId, peerAccountId, accountId);
  const rows = (
    database
      .prepare(
        `SELECT * FROM direct_messages
     WHERE organization_id = ? AND (
       (sender_account_id = ? AND recipient_account_id = ?) OR
       (sender_account_id = ? AND recipient_account_id = ?)
     ) ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        organizationId,
        accountId,
        peerAccountId,
        peerAccountId,
        accountId,
        limit,
      ) as DirectMessageRow[]
  ).reverse();
  const attachmentsByMessage = listDirectMessageAttachmentMap(
    database,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    toDirectMessageView(store, row, attachmentsByMessage.get(row.id) ?? []),
  );
}

export interface GetDirectMessageAttachmentInput {
  organizationId: string;
  accountId: string;
  attachmentId: string;
}

export function getDirectMessageAttachmentFromRepository(
  store: DirectMessageRepositoryStore,
  input: GetDirectMessageAttachmentInput,
): DirectMessageAttachmentDownload {
  const organizationId = input.organizationId.trim();
  const accountId = input.accountId.trim();
  const attachmentId = input.attachmentId.trim();
  if (!store.getActiveAccountInOrganization(accountId, organizationId)) {
    throw new Error('attachment account is not active in organization');
  }
  const row = store
    .db()
    .prepare(
      'SELECT a.id, a.file_name, a.mime_type, a.byte_size, a.content, ' +
        'a.storage_backend, a.storage_key ' +
        'FROM direct_message_attachments a ' +
        'JOIN direct_messages m ON m.id = a.message_id AND m.organization_id = a.organization_id ' +
        'WHERE a.id = ? AND a.organization_id = ? ' +
        'AND (m.sender_account_id = ? OR m.recipient_account_id = ?)',
    )
    .get(attachmentId, organizationId, accountId, accountId) as
    DirectMessageAttachmentContentRow | undefined;
  if (!row) throw new Error('附件不存在或无权访问');
  let content: Buffer;
  if (row.storage_backend === 'encrypted-filesystem') {
    if (!row.storage_key || !store.attachmentObjectStore) {
      throw new Error('attachment object storage is unavailable');
    }
    content = store.attachmentObjectStore.read(row.storage_key);
  } else if (row.storage_backend === 'sqlite') {
    content = Buffer.from(row.content);
  } else {
    throw new Error('attachment storage backend is unsupported');
  }
  if (content.length !== Number(row.byte_size)) {
    throw new Error('attachment content size mismatch');
  }
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: Number(row.byte_size),
    data: content.toString('base64'),
  };
}

export interface UnreadDirectMessageNotification {
  id: string;
  source: 'enterprise';
  title: string;
  senderAccountId: string;
  senderName: string;
  preview: string;
  createdAt: string;
}

/**
 * 后台通知轮询专用：只读未读摘要，绝不修改 read_at。真正打开会话时仍由
 * listDirectMessages 统一标记已读，避免系统弹窗把消息“看没了”。
 */
export interface ListUnreadDirectMessageNotificationsInput {
  organizationId: string;
  accountId: string;
  limit?: number;
}

export function listUnreadDirectMessageNotificationsFromRepository(
  store: DirectMessageRepositoryStore,
  input: ListUnreadDirectMessageNotificationsInput,
): UnreadDirectMessageNotification[] {
  const organizationId = input.organizationId.trim();
  const accountId = input.accountId.trim();
  const account = store.getActiveAccountInOrganization(
    accountId,
    organizationId,
  );
  if (!account) throw new Error('账号不存在或已停用');
  const limit = normalizeResultLimit(input.limit, 50, 100);
  const rows = store
    .db()
    .prepare(
      `SELECT m.*, a.name AS sender_name
     FROM direct_messages m
     JOIN accounts a ON a.id = m.sender_account_id
       AND a.organization_id = m.organization_id
       AND a.deleted_at IS NULL
     WHERE m.organization_id = ? AND m.recipient_account_id = ?
       AND m.read_at IS NULL
     ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    )
  .all(organizationId, accountId, limit) as Array<
    DirectMessageRow & { sender_name: string }
  >;
  for (const row of rows) {
    row.content = directMessageContentFromRepository(store, row);
  }
  return rows.reverse().map((row) => ({
    id: row.id,
    source: 'enterprise' as const,
    title: `${row.sender_name} 发来消息`,
    senderAccountId: row.sender_account_id,
    senderName: row.sender_name,
    preview:
      row.content.length > 160 ? `${row.content.slice(0, 157)}…` : row.content,
    createdAt: row.created_at,
  }));
}

export interface ListPendingAtoaRequestsInput {
  organizationId: string;
  accountId: string;
  requestPrefix: string;
  responsePrefix: string;
  limit?: number;
}

export function listPendingAtoaRequestsFromRepository(
  store: DirectMessageRepositoryStore,
  input: ListPendingAtoaRequestsInput,
): AtoaInboxMessageView[] {
  const organizationId = input.organizationId.trim();
  const accountId = input.accountId.trim();
  if (!store.getActiveAccountInOrganization(accountId, organizationId)) {
    throw new Error('A2A account is not active in organization');
  }
  if (
    !input.requestPrefix ||
    !input.responsePrefix ||
    input.requestPrefix === input.responsePrefix
  ) {
    throw new Error('A2A protocol prefixes are invalid');
  }
  const limit = normalizeResultLimit(input.limit, 50, 100);
  const database = store.db();
  const requestCandidates = database
    .prepare(
      `SELECT * FROM direct_messages
     WHERE organization_id = ?
       AND recipient_account_id = ?
       AND content_type = 'atoa_request'
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    )
    .all(organizationId, accountId, limit) as DirectMessageRow[];
  const requests = requestCandidates.filter((row) =>
    directMessageContentFromRepository(store, row).startsWith(
      input.requestPrefix,
    ),
  ).slice(0, limit);
  const responseCandidates = database
    .prepare(
      `SELECT * FROM direct_messages
     WHERE organization_id = ?
       AND sender_account_id = ?
       AND content_type = 'atoa_response'
     ORDER BY created_at DESC, id DESC
     LIMIT 300`,
    )
    .all(organizationId, accountId) as DirectMessageRow[];
  const responses = responseCandidates
    .map((row) => ({
      ...row,
      decryptedContent: directMessageContentFromRepository(store, row),
    }))
    .filter((row) => row.decryptedContent.startsWith(input.responsePrefix));
  return requests
    .filter(
      (request) =>
        !responses.some(
          (response) =>
            response.sender_account_id === accountId &&
            response.recipient_account_id === request.sender_account_id &&
            parseAtoaResponseRequestId(
              response.decryptedContent,
              input.responsePrefix,
            ) === request.id,
        ),
    )
    .reverse()
    .map((request) => ({
      ...toDirectMessageView(store, request),
      peerAccountId: request.sender_account_id,
    }));
}

const ATOA_RESPONSE_SOURCES = new Set([
  'current_chat',
  'enterprise_knowledge',
  'work_logs',
  'schedules',
]);

function isAtoaResponseText(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function parseAtoaResponseRequestId(
  content: string,
  responsePrefix: string,
): string | null {
  if (!content.startsWith(responsePrefix)) return null;
  try {
    const parsed = JSON.parse(content.slice(responsePrefix.length)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    const response = parsed as Record<string, unknown>;
    const mode = response.mode === undefined ? 'answer' : response.mode;
    const sources =
      response.grantedSources === undefined ? [] : response.grantedSources;
    if (
      response.v !== 1 ||
      !isAtoaResponseText(response.requestId, 200) ||
      !isAtoaResponseText(response.question, 1200) ||
      !isAtoaResponseText(response.answer, 2400) ||
      !isAtoaResponseText(response.createdAt, 64) ||
      !Number.isFinite(Date.parse(response.createdAt)) ||
      (mode !== 'answer' && mode !== 'consult') ||
      !Array.isArray(sources) ||
      sources.length > ATOA_RESPONSE_SOURCES.size ||
      sources.some(
        (source) =>
          typeof source !== 'string' || !ATOA_RESPONSE_SOURCES.has(source),
      )
    ) {
      return null;
    }
    return response.requestId;
  } catch {
    return null;
  }
}

/**
 * A2A 回复落库成功后，将它精确对应的原始请求标为已读。匹配同时限定租户、
 * 双方方向、消息主键和协议前缀，不能借 response requestId 标记普通消息或
 * 其他成员的请求；后台未读轮询本身仍保持完全只读。
 */
export interface MarkAtoaRequestReadFromResponseInput {
  organizationId: string;
  responderAccountId: string;
  peerAccountId: string;
  responseContent: string;
  requestPrefix: string;
  responsePrefix: string;
}

export function markAtoaRequestReadFromResponseInRepository(
  store: DirectMessageRepositoryStore,
  input: MarkAtoaRequestReadFromResponseInput,
): string | null {
  const organizationId = input.organizationId.trim();
  const responderAccountId = input.responderAccountId.trim();
  const peerAccountId = input.peerAccountId.trim();
  if (
    !store.getActiveAccountInOrganization(responderAccountId, organizationId) ||
    !store.getActiveAccountInOrganization(peerAccountId, organizationId)
  ) {
    return null;
  }
  if (
    !input.requestPrefix ||
    !input.responsePrefix ||
    input.requestPrefix === input.responsePrefix
  ) {
    return null;
  }
  const requestId = parseAtoaResponseRequestId(
    input.responseContent,
    input.responsePrefix,
  );
  if (!requestId) return null;
  const database = store.db();
  const request = database
    .prepare(
      `SELECT * FROM direct_messages
       WHERE id = ? AND organization_id = ?
         AND sender_account_id = ? AND recipient_account_id = ?
         AND read_at IS NULL`,
    )
    .get(
      requestId,
      organizationId,
      peerAccountId,
      responderAccountId,
    ) as DirectMessageRow | undefined;
  if (
    !request ||
    !directMessageContentFromRepository(store, request).startsWith(
      input.requestPrefix,
    )
  ) {
    return null;
  }
  const changed = database
    .prepare(
      `UPDATE direct_messages SET read_at = COALESCE(read_at, datetime('now'))
     WHERE id = ? AND organization_id = ?
       AND sender_account_id = ? AND recipient_account_id = ?
       AND read_at IS NULL`,
    )
    .run(
      requestId,
      organizationId,
      peerAccountId,
      responderAccountId,
    );
  return Number(changed.changes) === 1 ? requestId : null;
}
