/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import { getAccount, getDB } from './db.js';

export interface DirectMessageView {
  id: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
  createdAt: string;
  readAt: string | null;
}

export interface AtoaInboxMessageView extends DirectMessageView {
  peerAccountId: string;
}

interface DirectMessageRow {
  id: string;
  sender_account_id: string;
  recipient_account_id: string;
  content: string;
  created_at: string;
  read_at: string | null;
}

function toDirectMessageView(row: DirectMessageRow): DirectMessageView {
  return {
    id: row.id,
    senderAccountId: row.sender_account_id,
    recipientAccountId: row.recipient_account_id,
    content: row.content,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export function sendDirectMessage(input: {
  organizationId: string;
  senderAccountId: string;
  recipientAccountId: string;
  content: string;
}): DirectMessageView {
  const content = input.content.trim();
  if (!content || content.length > 4000)
    throw new Error('消息内容长度必须为 1 到 4000 个字符');
  if (input.senderAccountId === input.recipientAccountId)
    throw new Error('不能给自己发送消息');
  const recipient = getAccount(input.recipientAccountId, input.organizationId);
  if (!recipient || recipient.status !== 'active')
    throw new Error('接收成员不存在或已停用');
  const id = randomUUID();
  getDB()
    .prepare(
      `INSERT INTO direct_messages
      (id, organization_id, sender_account_id, recipient_account_id, content)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.organizationId,
      input.senderAccountId,
      input.recipientAccountId,
      content,
    );
  const row = getDB()
    .prepare('SELECT * FROM direct_messages WHERE id = ?')
    .get(id) as DirectMessageRow;
  return toDirectMessageView(row);
}

export function listDirectMessages(input: {
  organizationId: string;
  accountId: string;
  peerAccountId: string;
  limit?: number;
}): DirectMessageView[] {
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 100)));
  getDB()
    .prepare(
      `UPDATE direct_messages SET read_at = COALESCE(read_at, datetime('now'))
     WHERE organization_id = ? AND sender_account_id = ? AND recipient_account_id = ?`,
    )
    .run(input.organizationId, input.peerAccountId, input.accountId);
  return (
    getDB()
      .prepare(
        `SELECT * FROM direct_messages
     WHERE organization_id = ? AND (
       (sender_account_id = ? AND recipient_account_id = ?) OR
       (sender_account_id = ? AND recipient_account_id = ?)
     ) ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        input.organizationId,
        input.accountId,
        input.peerAccountId,
        input.peerAccountId,
        input.accountId,
        limit,
      ) as DirectMessageRow[]
  )
    .reverse()
    .map(toDirectMessageView);
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
export function listUnreadDirectMessageNotifications(input: {
  organizationId: string;
  accountId: string;
  limit?: number;
}): UnreadDirectMessageNotification[] {
  const account = getAccount(input.accountId, input.organizationId);
  if (!account || account.status !== 'active')
    throw new Error('账号不存在或已停用');
  const requestedLimit = input.limit ?? 50;
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(100, Math.max(1, Math.floor(requestedLimit)))
    : 50;
  const rows = getDB()
    .prepare(
      `SELECT m.id, m.sender_account_id, m.content, m.created_at, a.name AS sender_name
     FROM direct_messages m
     JOIN accounts a ON a.id = m.sender_account_id
       AND a.organization_id = m.organization_id
       AND a.deleted_at IS NULL
     WHERE m.organization_id = ? AND m.recipient_account_id = ?
       AND m.read_at IS NULL
     ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    )
    .all(input.organizationId, input.accountId, limit) as Array<{
    id: string;
    sender_account_id: string;
    content: string;
    created_at: string;
    sender_name: string;
  }>;
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

export function listPendingAtoaRequests(input: {
  organizationId: string;
  accountId: string;
  requestPrefix: string;
  responsePrefix: string;
  limit?: number;
}): AtoaInboxMessageView[] {
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
  const requests = getDB()
    .prepare(
      `SELECT * FROM direct_messages
     WHERE organization_id = ?
       AND recipient_account_id = ?
       AND content LIKE ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    )
    .all(
      input.organizationId,
      input.accountId,
      `${input.requestPrefix}%`,
      limit,
    ) as DirectMessageRow[];
  const responses = getDB()
    .prepare(
      `SELECT sender_account_id, recipient_account_id, content FROM direct_messages
     WHERE organization_id = ?
       AND sender_account_id = ?
       AND content LIKE ?
     ORDER BY created_at DESC, id DESC
     LIMIT 300`,
    )
    .all(
      input.organizationId,
      input.accountId,
      `${input.responsePrefix}%`,
    ) as Array<{
    sender_account_id: string;
    recipient_account_id: string;
    content: string;
  }>;
  return requests
    .filter(
      (request) =>
        !responses.some(
          (response) =>
            response.sender_account_id === input.accountId &&
            response.recipient_account_id === request.sender_account_id &&
            parseAtoaResponseRequestId(
              response.content,
              input.responsePrefix,
            ) === request.id,
        ),
    )
    .reverse()
    .map((request) => ({
      ...toDirectMessageView(request),
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
export function markAtoaRequestReadFromResponse(input: {
  organizationId: string;
  responderAccountId: string;
  peerAccountId: string;
  responseContent: string;
  requestPrefix: string;
  responsePrefix: string;
}): string | null {
  const requestId = parseAtoaResponseRequestId(
    input.responseContent,
    input.responsePrefix,
  );
  if (!requestId) return null;
  const changed = getDB()
    .prepare(
      `UPDATE direct_messages SET read_at = COALESCE(read_at, datetime('now'))
     WHERE id = ? AND organization_id = ?
       AND sender_account_id = ? AND recipient_account_id = ?
       AND read_at IS NULL AND content LIKE ?`,
    )
    .run(
      requestId,
      input.organizationId,
      input.peerAccountId,
      input.responderAccountId,
      `${input.requestPrefix}%`,
    );
  return Number(changed.changes) === 1 ? requestId : null;
}
