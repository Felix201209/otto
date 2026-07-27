/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import {
  type AccountRow,
  type AccountView,
  getAccount,
  getDB,
  getParkForOrganization,
  listParkTenantOrganizations,
  logAudit,
  toAccountView,
} from './db.js';

export interface ParkPublicationView {
  id: string;
  kind: 'announcement' | 'satisfaction';
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  submittedAt: string | null;
  responseData: Record<string, string> | null;
  recipientCount: number;
  readCount: number;
}

export interface ParkAnnouncementResultView {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  recipientCount: number;
  readCount: number;
}

export interface ParkSurveyResultView {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  recipientCount: number;
  submittedCount: number;
  responses: Array<{
    accountId: string;
    accountName: string;
    submittedAt: string;
    responseData: Record<string, string>;
  }>;
}

interface ParkPublicationRow {
  id: string;
  kind: 'announcement' | 'satisfaction';
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
  submitted_at: string | null;
  response_data: string | null;
  recipient_count?: number;
  read_count?: number;
}

function publicationView(row: ParkPublicationRow): ParkPublicationView {
  let responseData: Record<string, string> | null = null;
  try {
    const value = row.response_data
      ? (JSON.parse(row.response_data) as unknown)
      : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      responseData = Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    }
  } catch {
    responseData = null;
  }
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
    submittedAt: row.submitted_at,
    responseData,
    recipientCount: Number(row.recipient_count) || 0,
    readCount: Number(row.read_count) || 0,
  };
}

export function createParkPublication(input: {
  createdByAccountId: string;
  kind: 'announcement' | 'satisfaction';
  title: string;
  body: string;
  recipientAccountId?: string | null;
}): { publication: ParkPublicationView; recipientCount: number } {
  const creator = getAccount(input.createdByAccountId);
  const park = creator ? getParkForOrganization(creator.organizationId) : null;
  if (!creator?.isAdmin || !park || park.adminOrganizationId !== creator.organizationId)
    throw new Error('Only enterprise administrators can publish park content');
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) throw new Error('title and body required');
  const tenantOrganizationIds = new Set(
    listParkTenantOrganizations(park.id).map((organization) => organization.id),
  );
  const recipients = input.recipientAccountId
    ? [getAccount(input.recipientAccountId)].filter(
        (account): account is AccountView => account !== null
          && account.status === 'active'
          && tenantOrganizationIds.has(account.organizationId),
      )
    : (getDB().prepare(
        `SELECT a.* FROM accounts a
         JOIN organizations o ON o.id = a.organization_id
         WHERE o.park_id = ? AND o.id <> ?
           AND o.status = 'active' AND a.status = 'active' AND a.deleted_at IS NULL
         ORDER BY o.name, a.name, a.username`,
      ).all(park.id, park.adminOrganizationId) as AccountRow[]).map(toAccountView);
  if (recipients.length === 0) throw new Error('No active park tenant recipients');
  const id = `park_publication_${randomUUID()}`;
  getDB()
    .prepare(
      `INSERT INTO park_publications
      (id, organization_id, kind, title, body, created_by_account_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, creator.organizationId, input.kind, title, body, creator.id);
  const insertRecipient = getDB().prepare(
    `INSERT INTO park_publication_recipients
      (organization_id, publication_id, account_id) VALUES (?, ?, ?)`,
  );
  for (const recipient of recipients) {
    insertRecipient.run(recipient.organizationId, id, recipient.id);
  }
  logAudit(
    'park_publication_create',
    creator.employeeId,
    `${input.kind} ${id} delivered to ${recipients.length} account(s)`,
    creator.organizationId,
  );
  return {
    publication: {
      id,
      kind: input.kind,
      title,
      body,
      createdAt: new Date().toISOString(),
      readAt: null,
      submittedAt: null,
      responseData: null,
      recipientCount: recipients.length,
      readCount: 0,
    },
    recipientCount: recipients.length,
  };
}

export function listParkPublications(accountId: string): ParkPublicationView[] {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const rows = getDB()
    .prepare(
      `SELECT p.id, p.kind, p.title, p.body, p.created_at,
            r.read_at, r.submitted_at, r.response_data,
            (SELECT COUNT(*) FROM park_publication_recipients all_r
             WHERE all_r.publication_id = p.id) AS recipient_count,
            (SELECT COUNT(*) FROM park_publication_recipients read_r
             WHERE read_r.publication_id = p.id AND read_r.read_at IS NOT NULL) AS read_count
     FROM park_publication_recipients r
     JOIN park_publications p ON p.id = r.publication_id
     WHERE r.account_id = ? AND r.organization_id = ?
     ORDER BY p.created_at DESC`,
    )
    .all(
      account.id,
      account.organizationId,
    ) as ParkPublicationRow[];
  return rows.map(publicationView);
}

export function listParkAnnouncementResults(
  accountId: string,
): ParkAnnouncementResultView[] {
  const account = getAccount(accountId);
  const park = account ? getParkForOrganization(account.organizationId) : null;
  if (!account?.isAdmin || !park || park.adminOrganizationId !== account.organizationId) {
    throw new Error('Only park administrators can view announcement results');
  }
  return (getDB().prepare(
    `SELECT p.id, p.title, p.body, p.created_at,
            COUNT(r.account_id) AS recipient_count,
            SUM(CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END) AS read_count
     FROM park_publications p
     LEFT JOIN park_publication_recipients r ON r.publication_id = p.id
     WHERE p.organization_id = ? AND p.kind = 'announcement'
     GROUP BY p.id, p.title, p.body, p.created_at
     ORDER BY p.created_at DESC`,
  ).all(account.organizationId) as Array<{
    id: string;
    title: string;
    body: string;
    created_at: string;
    recipient_count: number;
    read_count: number;
  }>).map((publication) => ({
    id: publication.id,
    title: publication.title,
    body: publication.body,
    createdAt: publication.created_at,
    recipientCount: Number(publication.recipient_count) || 0,
    readCount: Number(publication.read_count) || 0,
  }));
}

/** 管理员查看本企业问卷回收情况；实名由账号表提供，不信任客户端自填姓名。 */
export function listParkSurveyResults(
  accountId: string,
): ParkSurveyResultView[] {
  const account = getAccount(accountId);
  const park = account ? getParkForOrganization(account.organizationId) : null;
  if (!account?.isAdmin || !park || park.adminOrganizationId !== account.organizationId)
    throw new Error('Only enterprise administrators can view survey results');
  const publications = getDB()
    .prepare(
      `SELECT p.id, p.title, p.body, p.created_at,
            COUNT(r.account_id) AS recipient_count,
            SUM(CASE WHEN r.submitted_at IS NOT NULL THEN 1 ELSE 0 END) AS submitted_count
     FROM park_publications p
     LEFT JOIN park_publication_recipients r ON r.publication_id = p.id
     WHERE p.organization_id = ? AND p.kind = 'satisfaction'
     GROUP BY p.id, p.title, p.body, p.created_at
     ORDER BY p.created_at DESC`,
    )
    .all(account.organizationId) as Array<{
    id: string;
    title: string;
    body: string;
    created_at: string;
    recipient_count: number;
    submitted_count: number;
  }>;
  const responseRows = getDB().prepare(
    `SELECT r.account_id, a.name AS account_name, r.submitted_at, r.response_data
     FROM park_publication_recipients r
     JOIN accounts a ON a.id = r.account_id AND a.organization_id = r.organization_id
     WHERE r.publication_id = ? AND r.submitted_at IS NOT NULL
     ORDER BY r.submitted_at DESC`,
  );
  return publications.map((publication) => {
    const rows = responseRows.all(
      publication.id,
    ) as Array<{
      account_id: string;
      account_name: string;
      submitted_at: string;
      response_data: string | null;
    }>;
    return {
      id: publication.id,
      title: publication.title,
      body: publication.body,
      createdAt: publication.created_at,
      recipientCount: Number(publication.recipient_count) || 0,
      submittedCount: Number(publication.submitted_count) || 0,
      responses: rows.map((row) => {
        let responseData: Record<string, string> = {};
        try {
          const value = row.response_data
            ? (JSON.parse(row.response_data) as unknown)
            : null;
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            responseData = Object.fromEntries(
              Object.entries(value).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string',
              ),
            );
          }
        } catch {
          responseData = {};
        }
        responseData.submittedBy = row.account_name;
        return {
          accountId: row.account_id,
          accountName: row.account_name,
          submittedAt: row.submitted_at,
          responseData,
        };
      }),
    };
  });
}

export function markParkPublicationRead(
  id: string,
  accountId: string,
): ParkPublicationView {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const changed = getDB()
    .prepare(
      `UPDATE park_publication_recipients
     SET read_at = COALESCE(read_at, datetime('now'))
     WHERE publication_id = ? AND account_id = ? AND organization_id = ?`,
    )
    .run(id, account.id, account.organizationId);
  if (changed.changes === 0)
    throw new Error('Publication not found or not assigned');
  const publication = listParkPublications(account.id).find(
    (item) => item.id === id,
  );
  if (!publication) throw new Error('Publication not found');
  return publication;
}

export function submitParkSurvey(
  id: string,
  accountId: string,
  responseData: Record<string, string>,
): ParkPublicationView {
  const account = getAccount(accountId);
  if (!account) throw new Error('Account not found');
  const publication = getDB().prepare(
    `SELECT p.kind FROM park_publications p
     JOIN park_publication_recipients r ON r.publication_id = p.id
     WHERE p.id = ? AND r.account_id = ? AND r.organization_id = ?`,
  ).get(id, account.id, account.organizationId) as { kind: string } | undefined;
  if (publication?.kind !== 'satisfaction') throw new Error('Survey not found');
  const normalized = Object.fromEntries(
    Object.entries(responseData)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      )
      .map(([key, value]) => [key.slice(0, 50), value.trim().slice(0, 2000)]),
  );
  normalized.submittedBy = account.name;
  const changed = getDB()
    .prepare(
      `UPDATE park_publication_recipients
     SET read_at = COALESCE(read_at, datetime('now')), submitted_at = datetime('now'), response_data = ?
     WHERE publication_id = ? AND account_id = ? AND organization_id = ? AND submitted_at IS NULL`,
    )
    .run(JSON.stringify(normalized), id, account.id, account.organizationId);
  if (changed.changes === 0)
    throw new Error('问卷不存在或已经提交，不能重复修改');
  const result = listParkPublications(account.id).find(
    (item) => item.id === id,
  );
  if (!result) throw new Error('Survey not found');
  logAudit(
    'park_survey_submit',
    account.employeeId,
    `Survey ${id} submitted`,
    account.organizationId,
  );
  return result;
}
