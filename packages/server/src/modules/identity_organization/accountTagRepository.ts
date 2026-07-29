/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';

export interface AccountTagRepositoryStore {
  db(): Database;
}

export interface AccountTagRecord {
  account_id: string;
  tag: string;
  created_at: string;
}

export function normalizeAccountTags(tags: string[] | undefined): string[] {
  return [
    ...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

export function listAccountTagsInRepository(
  store: AccountTagRepositoryStore,
  accountId: string,
  organizationId: string,
): string[] {
  return (
    store
      .db()
      .prepare(
        `SELECT tag FROM account_tags
         WHERE account_id = ? AND organization_id = ?
         ORDER BY tag`,
      )
      .all(accountId, organizationId) as Array<{ tag: string }>
  ).map((row) => row.tag);
}

export function listOrganizationAccountTagsInRepository(
  store: AccountTagRepositoryStore,
  organizationId: string,
): AccountTagRecord[] {
  return store
    .db()
    .prepare(
      `SELECT account_id, tag, created_at FROM account_tags
       WHERE organization_id = ?
       ORDER BY account_id, tag`,
    )
    .all(organizationId) as AccountTagRecord[];
}

function insertAccountTags(
  database: Database,
  accountId: string,
  organizationId: string,
  tags: string[],
): void {
  const insert = database.prepare(
    'INSERT INTO account_tags (organization_id, account_id, tag) VALUES (?, ?, ?)',
  );
  for (const tag of normalizeAccountTags(tags)) {
    insert.run(organizationId, accountId, tag);
  }
}

function replaceWithinSavepoint(
  database: Database,
  savepoint: string,
  replace: () => void,
): void {
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    replace();
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}

export function replaceAccountTagsInRepository(
  store: AccountTagRepositoryStore,
  accountId: string,
  organizationId: string,
  tags: string[],
): void {
  const database = store.db();
  replaceWithinSavepoint(database, 'replace_account_tags', () => {
    database
      .prepare(
        'DELETE FROM account_tags WHERE account_id = ? AND organization_id = ?',
      )
      .run(accountId, organizationId);
    insertAccountTags(database, accountId, organizationId, tags);
  });
}

export function replaceMigratedAccountTagsInRepository(
  store: AccountTagRepositoryStore,
  accountId: string,
  organizationId: string,
  tags: string[],
): void {
  const database = store.db();
  replaceWithinSavepoint(database, 'replace_migrated_account_tags', () => {
    database
      .prepare('DELETE FROM account_tags WHERE account_id = ?')
      .run(accountId);
    insertAccountTags(database, accountId, organizationId, tags);
  });
}

export function deleteAccountTagsInRepository(
  store: AccountTagRepositoryStore,
  accountId: string,
  organizationId: string,
): void {
  store
    .db()
    .prepare(
      'DELETE FROM account_tags WHERE account_id = ? AND organization_id = ?',
    )
    .run(accountId, organizationId);
}
