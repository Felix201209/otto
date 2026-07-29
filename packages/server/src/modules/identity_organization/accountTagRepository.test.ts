/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { Database } from '../data_platform/index.js';
import {
  deleteAccountTagsInRepository,
  listAccountTagsInRepository,
  listOrganizationAccountTagsInRepository,
  normalizeAccountTags,
  replaceAccountTagsInRepository,
  replaceMigratedAccountTagsInRepository,
} from './accountTagRepository.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE account_tags (
      organization_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (account_id, tag)
    );
  `);
  return database;
}

describe('account tag repository', () => {
  it('normalizes labels and reads only the requested account and tenant', () => {
    const database = createDatabase();
    try {
      const store = { db: () => database };
      database.exec(`
        INSERT INTO account_tags (organization_id, account_id, tag) VALUES
          ('org-a', 'account-a', '研发'),
          ('org-a', 'account-a', 'IT'),
          ('org-a', 'account-b', '财务'),
          ('org-b', 'account-a', '历史标签');
      `);

      expect(normalizeAccountTags([' 研发 ', 'IT', '研发', ''])).toEqual([
        '研发',
        'IT',
      ]);
      expect(listAccountTagsInRepository(store, 'account-a', 'org-a')).toEqual([
        'IT',
        '研发',
      ]);
    } finally {
      database.close();
    }
  });

  it('replaces only the requested tenant assignment', () => {
    const database = createDatabase();
    try {
      const store = { db: () => database };
      database.exec(`
        INSERT INTO account_tags (organization_id, account_id, tag) VALUES
          ('org-a', 'account-a', '旧标签'),
          ('org-b', 'account-a', '历史标签'),
          ('org-a', 'account-b', '保留标签');
      `);

      replaceAccountTagsInRepository(store, 'account-a', 'org-a', [
        ' 新标签 ',
        'Alpha',
        '新标签',
      ]);

      expect(listAccountTagsInRepository(store, 'account-a', 'org-a')).toEqual([
        'Alpha',
        '新标签',
      ]);
      expect(listAccountTagsInRepository(store, 'account-a', 'org-b')).toEqual([
        '历史标签',
      ]);
      expect(listAccountTagsInRepository(store, 'account-b', 'org-a')).toEqual([
        '保留标签',
      ]);
    } finally {
      database.close();
    }
  });

  it('removes all legacy tenant labels when an account joins an enterprise', () => {
    const database = createDatabase();
    try {
      const store = { db: () => database };
      database.exec(`
        INSERT INTO account_tags (organization_id, account_id, tag) VALUES
          ('personal-org', 'account-a', '个人标签'),
          ('old-org', 'account-a', '旧企业标签'),
          ('old-org', 'account-b', '其他账号标签');
      `);

      replaceMigratedAccountTagsInRepository(store, 'account-a', 'new-org', [
        '普通成员',
      ]);

      expect(
        database
          .prepare(
            `SELECT organization_id, account_id, tag FROM account_tags
             ORDER BY account_id, tag`,
          )
          .all(),
      ).toEqual([
        {
          organization_id: 'new-org',
          account_id: 'account-a',
          tag: '普通成员',
        },
        {
          organization_id: 'old-org',
          account_id: 'account-b',
          tag: '其他账号标签',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('deletes only one account assignment during account removal', () => {
    const database = createDatabase();
    try {
      const store = { db: () => database };
      database.exec(`
        INSERT INTO account_tags (organization_id, account_id, tag) VALUES
          ('org-a', 'account-a', '删除标签'),
          ('org-b', 'account-a', '历史标签'),
          ('org-a', 'account-b', '保留标签');
      `);

      deleteAccountTagsInRepository(store, 'account-a', 'org-a');

      expect(listAccountTagsInRepository(store, 'account-a', 'org-a')).toEqual(
        [],
      );
      expect(listAccountTagsInRepository(store, 'account-a', 'org-b')).toEqual([
        '历史标签',
      ]);
      expect(listAccountTagsInRepository(store, 'account-b', 'org-a')).toEqual([
        '保留标签',
      ]);
    } finally {
      database.close();
    }
  });

  it('rolls back deleted labels when a replacement insert fails', () => {
    const database = createDatabase();
    try {
      const store = { db: () => database };
      database.exec(`
        INSERT INTO account_tags (organization_id, account_id, tag)
        VALUES ('org-a', 'account-a', '旧标签');
        CREATE TRIGGER reject_account_tag
        BEFORE INSERT ON account_tags
        WHEN NEW.tag = 'reject'
        BEGIN
          SELECT RAISE(ABORT, 'rejected tag');
        END;
      `);

      expect(() =>
        replaceAccountTagsInRepository(store, 'account-a', 'org-a', [
          'accepted',
          'reject',
        ]),
      ).toThrow('rejected tag');

      expect(listAccountTagsInRepository(store, 'account-a', 'org-a')).toEqual([
        '旧标签',
      ]);
    } finally {
      database.close();
    }
  });

  it('exports only one organization with deterministic ordering', () => {
    const database = createDatabase();
    try {
      const store = { db: () => database };
      database.exec(`
        INSERT INTO account_tags
          (organization_id, account_id, tag, created_at)
        VALUES
          ('org-a', 'account-b', '研发', '2026-01-03'),
          ('org-a', 'account-a', 'IT', '2026-01-02'),
          ('org-b', 'account-c', '其他', '2026-01-01');
      `);

      expect(listOrganizationAccountTagsInRepository(store, 'org-a')).toEqual([
        { account_id: 'account-a', tag: 'IT', created_at: '2026-01-02' },
        { account_id: 'account-b', tag: '研发', created_at: '2026-01-03' },
      ]);
    } finally {
      database.close();
    }
  });
});
