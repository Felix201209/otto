/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createParkPublicationFacade,
  type ParkPublicationRepositoryStore,
} from './modules/park_services/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      park_id TEXT
    );
    CREATE TABLE parks (
      id TEXT PRIMARY KEY,
      admin_organization_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      employee_id TEXT,
      username TEXT NOT NULL,
      name TEXT NOT NULL,
      is_admin INTEGER NOT NULL,
      status TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE park_publications (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_by_account_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE park_publication_recipients (
      organization_id TEXT NOT NULL,
      publication_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      read_at TEXT,
      submitted_at TEXT,
      response_data TEXT,
      PRIMARY KEY (publication_id, account_id)
    );

    INSERT INTO parks (id, admin_organization_id, status) VALUES
      ('park-a', 'park-admin-a', 'active'),
      ('park-b', 'park-admin-b', 'active'),
      ('park-disabled', 'park-admin-disabled', 'disabled');
    INSERT INTO organizations (id, name, status, park_id) VALUES
      ('park-admin-a', '甲园区', 'active', 'park-a'),
      ('tenant-a', '甲企业', 'active', 'park-a'),
      ('tenant-b', '乙企业', 'active', 'park-a'),
      ('tenant-disabled', '停用企业', 'disabled', 'park-a'),
      ('park-admin-b', '乙园区', 'active', 'park-b'),
      ('tenant-other', '其他园区企业', 'active', 'park-b'),
      ('park-admin-disabled', '停用园区企业', 'active', 'park-disabled'),
      ('disabled-admin-org', '停用管理企业', 'disabled', 'park-a');
    INSERT INTO accounts
      (id, organization_id, employee_id, username, name, is_admin, status, deleted_at) VALUES
      ('admin-a', 'park-admin-a', 'emp-admin-a', 'admin-a', '园区管理员甲', 1, 'active', NULL),
      ('member-a', 'park-admin-a', 'emp-member-a', 'member-a', '园区普通成员', 0, 'active', NULL),
      ('admin-b', 'park-admin-b', 'emp-admin-b', 'admin-b', '园区管理员乙', 1, 'active', NULL),
      ('admin-disabled-park', 'park-admin-disabled', 'emp-disabled-park', 'admin-disabled-park', '停用园区管理员', 1, 'active', NULL),
      ('admin-disabled-org', 'disabled-admin-org', 'emp-disabled-org', 'admin-disabled-org', '停用企业管理员', 1, 'active', NULL),
      ('tenant-a-user', 'tenant-a', 'emp-a-user', 'tenant-a-user', '甲企业员工', 0, 'active', NULL),
      ('tenant-a-admin', 'tenant-a', 'emp-a-admin', 'tenant-a-admin', '甲企业管理员', 1, 'active', NULL),
      ('tenant-a-disabled', 'tenant-a', 'emp-a-disabled', 'tenant-a-disabled', '停用员工', 0, 'disabled', NULL),
      ('tenant-a-deleted', 'tenant-a', 'emp-a-deleted', 'tenant-a-deleted', '删除员工', 0, 'active', '2026-01-01'),
      ('tenant-b-user', 'tenant-b', 'emp-b-user', 'tenant-b-user', '乙企业员工', 0, 'active', NULL),
      ('tenant-disabled-user', 'tenant-disabled', 'emp-disabled-user', 'tenant-disabled-user', '停用企业员工', 0, 'active', NULL),
      ('other-user', 'tenant-other', 'emp-other', 'other-user', '其他园区员工', 0, 'active', NULL);
  `);
  return database;
}

function createStore(database: Database): {
  store: ParkPublicationRepositoryStore;
  auditEvents: string[];
} {
  const auditEvents: string[] = [];
  let sequence = 0;
  return {
    auditEvents,
    store: {
      db: () => database,
      getAccount: (accountId) => {
        const row = database
          .prepare(
            `SELECT id, organization_id, employee_id, name, is_admin, status
             FROM accounts WHERE id = ? AND deleted_at IS NULL`,
          )
          .get(accountId) as
          | {
              id: string;
              organization_id: string;
              employee_id: string | null;
              name: string;
              is_admin: number;
              status: string;
            }
          | undefined;
        return row
          ? {
              id: row.id,
              organizationId: row.organization_id,
              employeeId: row.employee_id,
              name: row.name,
              isAdmin: row.is_admin === 1,
              status: row.status,
            }
          : null;
      },
      getParkForOrganization: (organizationId) => {
        const row = database
          .prepare(
            `SELECT p.id, p.admin_organization_id, p.status
             FROM organizations o JOIN parks p ON p.id = o.park_id
             WHERE o.id = ? AND p.status = 'active'`,
          )
          .get(organizationId) as
          | {
              id: string;
              admin_organization_id: string;
              status: 'active' | 'disabled';
            }
          | undefined;
        return row
          ? {
              id: row.id,
              adminOrganizationId: row.admin_organization_id,
              status: row.status,
            }
          : null;
      },
      createPublicationId: () => `publication-${++sequence}`,
      audit: (event, _employeeId, detail) => {
        auditEvents.push(`${event}:${detail}`);
      },
    },
  };
}

describe('park publication kernel', () => {
  it('publishes to an active tenant snapshot and excludes unsafe recipients', () => {
    const database = createDatabase();
    const { store, auditEvents } = createStore(database);
    const publications = createParkPublicationFacade(store);

    try {
      const result = publications.createParkPublication({
        createdByAccountId: 'admin-a',
        kind: 'announcement',
        title: ' 园区停水通知 ',
        body: ' 今天 14:00 停水 ',
      });
      expect(result).toMatchObject({
        recipientCount: 3,
        publication: {
          kind: 'announcement',
          title: '园区停水通知',
          body: '今天 14:00 停水',
          recipientCount: 3,
        },
      });
      expect(
        database
          .prepare(
            'SELECT account_id FROM park_publication_recipients ORDER BY account_id',
          )
          .all()
          .map((row) => (row as { account_id: string }).account_id),
      ).toEqual(['tenant-a-admin', 'tenant-a-user', 'tenant-b-user']);
      expect(auditEvents).toEqual([
        expect.stringContaining('park_publication_create:announcement'),
      ]);
    } finally {
      database.close();
    }
  });

  it('rejects cross-park targets and inactive or non-admin publishers', () => {
    const database = createDatabase();
    const publications = createParkPublicationFacade(createStore(database).store);
    const publish = (createdByAccountId: string, recipientAccountId?: string) =>
      publications.createParkPublication({
        createdByAccountId,
        kind: 'announcement',
        title: '通知',
        body: '内容',
        recipientAccountId,
      });

    try {
      expect(() => publish('admin-a', 'other-user')).toThrow(
        'No active park tenant recipients',
      );
      expect(() => publish('admin-a', 'tenant-a-disabled')).toThrow(
        'No active park tenant recipients',
      );
      expect(() => publish('member-a')).toThrow(
        'Only enterprise administrators can publish park content',
      );
      expect(() => publish('admin-disabled-park')).toThrow(
        'Only enterprise administrators can publish park content',
      );
      expect(() => publish('admin-disabled-org')).toThrow('Account not found');
    } finally {
      database.close();
    }
  });

  it('keeps recipient counts as a snapshot but blocks access after leaving the park', () => {
    const database = createDatabase();
    const publications = createParkPublicationFacade(createStore(database).store);

    try {
      const created = publications.createParkPublication({
        createdByAccountId: 'admin-a',
        kind: 'announcement',
        title: '通知',
        body: '内容',
        recipientAccountId: 'tenant-a-user',
      });
      const publicationId = created.publication.id;
      expect(publications.listParkPublications('tenant-a-user')).toHaveLength(1);
      expect(
        publications.markParkPublicationRead(publicationId, 'tenant-a-user'),
      ).toMatchObject({ readAt: expect.any(String), readCount: 1 });
      expect(
        publications.markParkPublicationRead(publicationId, 'tenant-a-user'),
      ).toMatchObject({ readAt: expect.any(String), readCount: 1 });
      expect(() =>
        publications.markParkPublicationRead(publicationId, 'tenant-b-user'),
      ).toThrow('Publication not found or not assigned');

      database
        .prepare("UPDATE organizations SET park_id = 'park-b' WHERE id = 'tenant-a'")
        .run();
      expect(publications.listParkPublications('tenant-a-user')).toEqual([]);
      expect(() =>
        publications.markParkPublicationRead(publicationId, 'tenant-a-user'),
      ).toThrow('Publication not found or not assigned');
      expect(publications.listParkAnnouncementResults('admin-a')).toEqual([
        expect.objectContaining({ recipientCount: 1, readCount: 1 }),
      ]);
    } finally {
      database.close();
    }
  });

  it('accepts one实名 survey response and ignores spoofed respondent names', () => {
    const database = createDatabase();
    const { store, auditEvents } = createStore(database);
    const publications = createParkPublicationFacade(store);

    try {
      const created = publications.createParkPublication({
        createdByAccountId: 'admin-a',
        kind: 'satisfaction',
        title: '满意度调查',
        body: '请评分',
        recipientAccountId: 'tenant-a-user',
      });
      const submitted = publications.submitParkSurvey(
        created.publication.id,
        'tenant-a-user',
        {
          rating: ' 5 ',
          submittedBy: '伪造姓名',
          ignored: 42,
        } as unknown as Record<string, string>,
      );
      expect(submitted).toMatchObject({
        submittedAt: expect.any(String),
        responseData: {
          rating: '5',
          submittedBy: '甲企业员工',
        },
      });
      expect(() =>
        publications.submitParkSurvey(
          created.publication.id,
          'tenant-a-user',
          { rating: '1' },
        ),
      ).toThrow('问卷不存在或已经提交，不能重复修改');
      expect(publications.listParkSurveyResults('admin-a')).toEqual([
        expect.objectContaining({
          recipientCount: 1,
          submittedCount: 1,
          responses: [
            expect.objectContaining({
              accountName: '甲企业员工',
              responseData: expect.objectContaining({
                rating: '5',
                submittedBy: '甲企业员工',
              }),
            }),
          ],
        }),
      ]);
      expect(() => publications.listParkSurveyResults('member-a')).toThrow(
        'Only enterprise administrators can view survey results',
      );
      expect(() => publications.listParkSurveyResults('admin-b')).not.toThrow();
      expect(publications.listParkSurveyResults('admin-b')).toEqual([]);
      expect(auditEvents).toEqual(
        expect.arrayContaining([
          expect.stringContaining('park_publication_create:satisfaction'),
          expect.stringContaining('park_survey_submit:Survey'),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it('rolls back publication and recipient writes when auditing fails', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    store.audit = () => {
      throw new Error('audit unavailable');
    };
    const publications = createParkPublicationFacade(store);

    try {
      expect(() =>
        publications.createParkPublication({
          createdByAccountId: 'admin-a',
          kind: 'announcement',
          title: '通知',
          body: '内容',
        }),
      ).toThrow('audit unavailable');
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM park_publications').get(),
      ).toMatchObject({ count: 0 });
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM park_publication_recipients')
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('rolls back a survey response when its audit record cannot be written', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    const publications = createParkPublicationFacade(store);

    try {
      const created = publications.createParkPublication({
        createdByAccountId: 'admin-a',
        kind: 'satisfaction',
        title: '满意度调查',
        body: '请评分',
        recipientAccountId: 'tenant-a-user',
      });
      store.audit = () => {
        throw new Error('audit unavailable');
      };
      expect(() =>
        publications.submitParkSurvey(
          created.publication.id,
          'tenant-a-user',
          { rating: '5' },
        ),
      ).toThrow('audit unavailable');
      expect(
        database
          .prepare(
            `SELECT read_at, submitted_at, response_data
             FROM park_publication_recipients WHERE publication_id = ?`,
          )
          .get(created.publication.id),
      ).toEqual({ read_at: null, submitted_at: null, response_data: null });
    } finally {
      database.close();
    }
  });
});
