/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import type {
  ParkAnnouncementResultView,
  ParkPublicationKind,
  ParkPublicationView,
  ParkSurveyResultView,
} from './parkPublicationTypes.js';

export interface ParkPublicationAccount {
  id: string;
  organizationId: string;
  employeeId: string | null;
  name: string;
  isAdmin: boolean;
  status: string;
}

export interface ParkPublicationPark {
  id: string;
  adminOrganizationId: string;
  status: 'active' | 'disabled';
}

interface ParkPublicationRow {
  id: string;
  kind: ParkPublicationKind;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
  submitted_at: string | null;
  response_data: string | null;
  recipient_count?: number;
  read_count?: number;
}

interface PublicationRecipient {
  id: string;
  organizationId: string;
}

export interface ParkPublicationRepositoryStore {
  db(): Database;
  getAccount(accountId: string): ParkPublicationAccount | null;
  getParkForOrganization(
    organizationId: string,
  ): ParkPublicationPark | null;
  createPublicationId(): string;
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
}

export interface CreateParkPublicationInput {
  createdByAccountId: string;
  kind: ParkPublicationKind;
  title: string;
  body: string;
  recipientAccountId?: string | null;
}

function parseResponseData(value: string | null): Record<string, string> | null {
  try {
    const parsed = value ? (JSON.parse(value) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
    }
  } catch {
    // Corrupt legacy payloads remain unreadable rather than leaking raw data.
  }
  return null;
}

function toPublicationView(row: ParkPublicationRow): ParkPublicationView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    readAt: row.read_at,
    submittedAt: row.submitted_at,
    responseData: parseResponseData(row.response_data),
    recipientCount: Number(row.recipient_count) || 0,
    readCount: Number(row.read_count) || 0,
  };
}

function requireActiveAccount(
  store: ParkPublicationRepositoryStore,
  accountId: string,
): ParkPublicationAccount {
  const account = store.getAccount(accountId);
  const organization = account
    ? (store
        .db()
        .prepare("SELECT id FROM organizations WHERE id = ? AND status = 'active'")
        .get(account.organizationId) as { id: string } | undefined)
    : undefined;
  if (!account || account.status !== 'active' || !organization) {
    throw new Error('Account not found');
  }
  return account;
}

function requireParkAdministrator(
  store: ParkPublicationRepositoryStore,
  accountId: string,
  message: string,
): { account: ParkPublicationAccount; park: ParkPublicationPark } {
  const account = requireActiveAccount(store, accountId);
  const park = store.getParkForOrganization(account.organizationId);
  if (
    !account.isAdmin ||
    !park ||
    park.status !== 'active' ||
    park.adminOrganizationId !== account.organizationId
  ) {
    throw new Error(message);
  }
  return { account, park };
}

function listActiveRecipients(
  store: ParkPublicationRepositoryStore,
  park: ParkPublicationPark,
  recipientAccountId?: string | null,
): PublicationRecipient[] {
  if (recipientAccountId) {
    const account = store.getAccount(recipientAccountId);
    if (!account || account.status !== 'active') return [];
    const tenant = store
      .db()
      .prepare(
        `SELECT id FROM organizations
         WHERE id = ? AND park_id = ? AND id <> ? AND status = 'active'`,
      )
      .get(account.organizationId, park.id, park.adminOrganizationId) as
      | { id: string }
      | undefined;
    return tenant
      ? [{ id: account.id, organizationId: account.organizationId }]
      : [];
  }

  return (
    store
      .db()
      .prepare(
        `SELECT a.id, a.organization_id
         FROM accounts a
         JOIN organizations o ON o.id = a.organization_id
         WHERE o.park_id = ? AND o.id <> ?
           AND o.status = 'active' AND a.status = 'active'
           AND a.deleted_at IS NULL
         ORDER BY o.name, a.name, a.username`,
      )
      .all(park.id, park.adminOrganizationId) as Array<{
      id: string;
      organization_id: string;
    }>
  ).map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
  }));
}

export function createParkPublicationInRepository(
  store: ParkPublicationRepositoryStore,
  input: CreateParkPublicationInput,
): { publication: ParkPublicationView; recipientCount: number } {
  const { account: creator, park } = requireParkAdministrator(
    store,
    input.createdByAccountId,
    'Only enterprise administrators can publish park content',
  );
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) throw new Error('title and body required');
  const recipients = listActiveRecipients(
    store,
    park,
    input.recipientAccountId,
  );
  if (recipients.length === 0) {
    throw new Error('No active park tenant recipients');
  }

  const id = store.createPublicationId();
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    database
      .prepare(
        `INSERT INTO park_publications
         (id, organization_id, kind, title, body, created_by_account_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, creator.organizationId, input.kind, title, body, creator.id);
    const insertRecipient = database.prepare(
      `INSERT INTO park_publication_recipients
       (organization_id, publication_id, account_id) VALUES (?, ?, ?)`,
    );
    for (const recipient of recipients) {
      insertRecipient.run(recipient.organizationId, id, recipient.id);
    }
    store.audit(
      'park_publication_create',
      creator.employeeId,
      `${input.kind} ${id} delivered to ${recipients.length} account(s)`,
      creator.organizationId,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  const created = database
    .prepare('SELECT created_at FROM park_publications WHERE id = ?')
    .get(id) as { created_at: string };
  return {
    publication: {
      id,
      kind: input.kind,
      title,
      body,
      createdAt: created.created_at,
      readAt: null,
      submittedAt: null,
      responseData: null,
      recipientCount: recipients.length,
      readCount: 0,
    },
    recipientCount: recipients.length,
  };
}

export function listParkPublicationsFromRepository(
  store: ParkPublicationRepositoryStore,
  accountId: string,
): ParkPublicationView[] {
  const account = requireActiveAccount(store, accountId);
  const rows = store
    .db()
    .prepare(
      `SELECT p.id, p.kind, p.title, p.body, p.created_at,
              r.read_at, r.submitted_at, r.response_data,
              (SELECT COUNT(*) FROM park_publication_recipients all_r
               WHERE all_r.publication_id = p.id) AS recipient_count,
              (SELECT COUNT(*) FROM park_publication_recipients read_r
               WHERE read_r.publication_id = p.id AND read_r.read_at IS NOT NULL) AS read_count
       FROM park_publication_recipients r
       JOIN park_publications p ON p.id = r.publication_id
       JOIN organizations tenant ON tenant.id = r.organization_id
         AND tenant.status = 'active'
       JOIN parks park ON park.id = tenant.park_id AND park.status = 'active'
       WHERE r.account_id = ? AND r.organization_id = ?
         AND p.organization_id = park.admin_organization_id
       ORDER BY p.created_at DESC`,
    )
    .all(account.id, account.organizationId) as ParkPublicationRow[];
  return rows.map(toPublicationView);
}

export function listParkAnnouncementResultsFromRepository(
  store: ParkPublicationRepositoryStore,
  accountId: string,
): ParkAnnouncementResultView[] {
  const { account } = requireParkAdministrator(
    store,
    accountId,
    'Only park administrators can view announcement results',
  );
  return (
    store
      .db()
      .prepare(
        `SELECT p.id, p.title, p.body, p.created_at,
                COUNT(r.account_id) AS recipient_count,
                SUM(CASE WHEN r.read_at IS NOT NULL THEN 1 ELSE 0 END) AS read_count
         FROM park_publications p
         LEFT JOIN park_publication_recipients r ON r.publication_id = p.id
         WHERE p.organization_id = ? AND p.kind = 'announcement'
         GROUP BY p.id, p.title, p.body, p.created_at
         ORDER BY p.created_at DESC`,
      )
      .all(account.organizationId) as Array<{
      id: string;
      title: string;
      body: string;
      created_at: string;
      recipient_count: number;
      read_count: number;
    }>
  ).map((publication) => ({
    id: publication.id,
    title: publication.title,
    body: publication.body,
    createdAt: publication.created_at,
    recipientCount: Number(publication.recipient_count) || 0,
    readCount: Number(publication.read_count) || 0,
  }));
}

export function listParkSurveyResultsFromRepository(
  store: ParkPublicationRepositoryStore,
  accountId: string,
): ParkSurveyResultView[] {
  const { account } = requireParkAdministrator(
    store,
    accountId,
    'Only enterprise administrators can view survey results',
  );
  const publications = store
    .db()
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
  const responseRows = store.db().prepare(
    `SELECT r.account_id, a.name AS account_name, r.submitted_at, r.response_data
     FROM park_publication_recipients r
     JOIN accounts a ON a.id = r.account_id AND a.organization_id = r.organization_id
     WHERE r.publication_id = ? AND r.submitted_at IS NOT NULL
     ORDER BY r.submitted_at DESC`,
  );

  return publications.map((publication) => ({
    id: publication.id,
    title: publication.title,
    body: publication.body,
    createdAt: publication.created_at,
    recipientCount: Number(publication.recipient_count) || 0,
    submittedCount: Number(publication.submitted_count) || 0,
    responses: (
      responseRows.all(publication.id) as Array<{
        account_id: string;
        account_name: string;
        submitted_at: string;
        response_data: string | null;
      }>
    ).map((row) => ({
      accountId: row.account_id,
      accountName: row.account_name,
      submittedAt: row.submitted_at,
      responseData: {
        ...(parseResponseData(row.response_data) ?? {}),
        submittedBy: row.account_name,
      },
    })),
  }));
}

function currentParkAssignmentSql(kind?: ParkPublicationKind): string {
  return `EXISTS (
    SELECT 1
    FROM park_publications p
    JOIN parks park ON park.admin_organization_id = p.organization_id
      AND park.status = 'active'
    JOIN organizations tenant
      ON tenant.id = park_publication_recipients.organization_id
      AND tenant.park_id = park.id AND tenant.status = 'active'
    WHERE p.id = park_publication_recipients.publication_id
      ${kind ? `AND p.kind = '${kind}'` : ''}
  )`;
}

export function markParkPublicationReadInRepository(
  store: ParkPublicationRepositoryStore,
  id: string,
  accountId: string,
): ParkPublicationView {
  const account = requireActiveAccount(store, accountId);
  const changed = store
    .db()
    .prepare(
      `UPDATE park_publication_recipients
       SET read_at = COALESCE(read_at, datetime('now'))
       WHERE publication_id = ? AND account_id = ? AND organization_id = ?
         AND ${currentParkAssignmentSql()}`,
    )
    .run(id, account.id, account.organizationId);
  if (Number(changed.changes) === 0) {
    throw new Error('Publication not found or not assigned');
  }
  const publication = listParkPublicationsFromRepository(store, account.id).find(
    (item) => item.id === id,
  );
  if (!publication) throw new Error('Publication not found');
  return publication;
}

export function submitParkSurveyInRepository(
  store: ParkPublicationRepositoryStore,
  id: string,
  accountId: string,
  responseData: Record<string, string>,
): ParkPublicationView {
  const account = requireActiveAccount(store, accountId);
  const normalized = Object.fromEntries(
    Object.entries(responseData)
      .filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      )
      .slice(0, 100)
      .map(([key, value]) => [key.slice(0, 50), value.trim().slice(0, 2000)]),
  );
  normalized.submittedBy = account.name;
  const database = store.db();
  database.exec('BEGIN IMMEDIATE');
  try {
    const changed = database
      .prepare(
        `UPDATE park_publication_recipients
         SET read_at = COALESCE(read_at, datetime('now')),
             submitted_at = datetime('now'), response_data = ?
         WHERE publication_id = ? AND account_id = ? AND organization_id = ?
           AND submitted_at IS NULL
           AND ${currentParkAssignmentSql('satisfaction')}`,
      )
      .run(JSON.stringify(normalized), id, account.id, account.organizationId);
    if (Number(changed.changes) === 0) {
      throw new Error('问卷不存在或已经提交，不能重复修改');
    }
    store.audit(
      'park_survey_submit',
      account.employeeId,
      `Survey ${id} submitted`,
      account.organizationId,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  const result = listParkPublicationsFromRepository(store, account.id).find(
    (item) => item.id === id,
  );
  if (!result) throw new Error('Survey not found');
  return result;
}
