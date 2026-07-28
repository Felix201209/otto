/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createParkStatisticsFacade,
  type ParkStatisticsRepositoryStore,
} from './modules/park_services/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      status TEXT NOT NULL,
      park_id TEXT
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      employee_id TEXT,
      name TEXT NOT NULL,
      is_admin INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE parks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      admin_organization_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE park_services (
      park_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (park_id, id)
    );
    CREATE TABLE park_data_statistics_tasks (
      id TEXT PRIMARY KEY,
      park_id TEXT NOT NULL,
      admin_organization_id TEXT NOT NULL,
      created_by_account_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      deadline TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      template_name TEXT,
      template_data TEXT,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE park_data_statistics_assignments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      park_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      ceo_account_id TEXT NOT NULL,
      assignee_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      response_data TEXT,
      return_reason TEXT,
      read_at TEXT,
      submitted_at TEXT,
      reviewed_at TEXT,
      last_reminded_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE it_tickets (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      park_id TEXT,
      service_id TEXT NOT NULL,
      form_data TEXT,
      created_at TEXT NOT NULL
    );

    INSERT INTO parks (id, name, admin_organization_id, status) VALUES
      ('park-a', 'A Park', 'park-admin-org', 'active'),
      ('park-b', 'B Park', 'other-admin-org', 'active'),
      ('park-disabled', 'Disabled Park', 'disabled-park-admin-org', 'disabled');
    INSERT INTO organizations (id, name, slug, status, park_id) VALUES
      ('park-admin-org', 'A Park Operator', 'park-admin', 'active', 'park-a'),
      ('tenant-a', 'Tenant A', 'tenant-a', 'active', 'park-a'),
      ('tenant-disabled', 'Disabled Tenant', 'tenant-disabled', 'disabled', 'park-a'),
      ('other-admin-org', 'B Park Operator', 'other-admin', 'active', 'park-b'),
      ('tenant-b', 'Tenant B', 'tenant-b', 'active', 'park-b'),
      ('disabled-park-admin-org', 'Disabled Park Operator', 'disabled-park-admin', 'active', 'park-disabled'),
      ('disabled-admin-org', 'Disabled Operator', 'disabled-admin', 'disabled', 'park-a');
    INSERT INTO accounts
      (id, organization_id, employee_id, name, is_admin, status) VALUES
      ('park-admin', 'park-admin-org', 'employee-park-admin', 'Park Admin', 1, 'active'),
      ('park-member', 'park-admin-org', 'employee-park-member', 'Park Member', 0, 'active'),
      ('tenant-ceo', 'tenant-a', 'employee-tenant-ceo', 'Tenant CEO', 1, 'active'),
      ('tenant-worker', 'tenant-a', 'employee-tenant-worker', 'Tenant Worker', 0, 'active'),
      ('tenant-disabled-account', 'tenant-a', 'employee-disabled', 'Disabled Worker', 0, 'disabled'),
      ('disabled-tenant-ceo', 'tenant-disabled', 'employee-disabled-tenant', 'Disabled Tenant CEO', 1, 'active'),
      ('other-admin', 'other-admin-org', 'employee-other-admin', 'Other Admin', 1, 'active'),
      ('other-ceo', 'tenant-b', 'employee-other-ceo', 'Other CEO', 1, 'active'),
      ('disabled-park-admin', 'disabled-park-admin-org', 'employee-disabled-park', 'Disabled Park Admin', 1, 'active'),
      ('disabled-admin', 'disabled-admin-org', 'employee-disabled-admin', 'Disabled Admin', 1, 'active');
    INSERT INTO park_services (park_id, id, name) VALUES
      ('park-a', 'parking', 'Parking'),
      ('park-a', 'meeting-room', 'Meeting room'),
      ('park-a', 'vehicle-visit', 'Vehicle visit');
  `);
  return database;
}

function createStore(database: Database): {
  store: ParkStatisticsRepositoryStore;
  auditEvents: string[];
  setFeatureEnabled(value: boolean): void;
} {
  let taskSequence = 0;
  let assignmentSequence = 0;
  let featureEnabled = true;
  const auditEvents: string[] = [];
  const store: ParkStatisticsRepositoryStore = {
    db: () => database,
    getAccount: (accountId, organizationId) => {
      const row = database
        .prepare(
          `SELECT id, organization_id, employee_id, is_admin, status
           FROM accounts
           WHERE id = ? AND (? IS NULL OR organization_id = ?)`,
        )
        .get(accountId, organizationId ?? null, organizationId ?? null) as
        | {
            id: string;
            organization_id: string;
            employee_id: string | null;
            is_admin: number;
            status: string;
          }
        | undefined;
      return row
        ? {
            id: row.id,
            organizationId: row.organization_id,
            employeeId: row.employee_id,
            isAdmin: row.is_admin === 1,
            status: row.status,
          }
        : null;
    },
    getPark: (parkId) => {
      const row = database
        .prepare(
          'SELECT id, name, admin_organization_id, status FROM parks WHERE id = ?',
        )
        .get(parkId) as
        | {
            id: string;
            name: string;
            admin_organization_id: string;
            status: 'active' | 'disabled';
          }
        | undefined;
      return row
        ? {
            id: row.id,
            name: row.name,
            adminOrganizationId: row.admin_organization_id,
            status: row.status,
          }
        : null;
    },
    getParkForOrganization: (organizationId) => {
      const parkId = database
        .prepare('SELECT park_id FROM organizations WHERE id = ?')
        .get(organizationId) as { park_id: string | null } | undefined;
      return parkId?.park_id ? store.getPark(parkId.park_id) : null;
    },
    getOrganizationFeatures: () => ({ park_service: featureEnabled }),
    listAccounts: (organizationId) =>
      (database
        .prepare(
          `SELECT id FROM accounts
           WHERE (? IS NULL OR organization_id = ?)
           ORDER BY id`,
        )
        .all(organizationId ?? null, organizationId ?? null) as Array<{
        id: string;
      }>)
        .map((row) => store.getAccount(row.id))
        .filter((account): account is NonNullable<typeof account> =>
          Boolean(account),
        ),
    listParkTenantOrganizations: (parkId) =>
      database
        .prepare(
          `SELECT id, name, slug, status
           FROM organizations
           WHERE park_id = ? AND id <> (
             SELECT admin_organization_id FROM parks WHERE id = ?
           )
           ORDER BY name`,
        )
        .all(parkId, parkId)
        .map((row) => {
          const organization = row as {
            id: string;
            name: string;
            slug: string;
            status: 'active' | 'disabled';
          };
          return {
            ...organization,
            parkAddress: `${organization.name} address`,
            parkRoomNumber: `${organization.name} room`,
          };
        }),
    listParkServices: (parkId) =>
      database
        .prepare('SELECT id, name FROM park_services WHERE park_id = ?')
        .all(parkId) as Array<{ id: string; name: string }>,
    createTaskId: () => `statistics-task-${++taskSequence}`,
    createAssignmentId: () =>
      `statistics-assignment-${++assignmentSequence}`,
    nowISO: () => '2026-07-28T08:00:00.000Z',
    audit: (event) => auditEvents.push(event),
  };
  return {
    store,
    auditEvents,
    setFeatureEnabled: (value) => {
      featureEnabled = value;
    },
  };
}

function createTask(
  statistics: ReturnType<typeof createParkStatisticsFacade>,
) {
  return statistics.createParkDataStatisticsTask({
    createdByAccountId: 'park-admin',
    title: 'Monthly operations',
    description: 'Submit the requested figures',
    deadline: '2099-12-31',
    fields: ['Revenue', 'Headcount'],
    organizationIds: ['tenant-a'],
  }).task;
}

describe('park statistics module', () => {
  it('enforces tenant isolation and legal assignment state transitions', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    const statistics = createParkStatisticsFacade(store);
    const task = createTask(statistics);

    expect(statistics.listParkDataStatisticsTasks('tenant-ceo')).toHaveLength(1);
    expect(statistics.listParkDataStatisticsTasks('other-ceo')).toEqual([]);
    statistics.delegateParkDataStatistics(
      task.id,
      'tenant-ceo',
      'tenant-worker',
    );
    statistics.submitParkDataStatisticsDraft(task.id, 'tenant-worker', {
      Revenue: '100000',
    });
    expect(() =>
      statistics.submitParkDataStatisticsDraft(task.id, 'tenant-worker', {
        Revenue: '200000',
      }),
    ).toThrow();
    statistics.reviewParkDataStatistics(
      task.id,
      'tenant-ceo',
      false,
      'Add headcount',
    );
    statistics.submitParkDataStatisticsDraft(task.id, 'tenant-worker', {
      Revenue: '100000',
      Headcount: '20',
    });
    statistics.reviewParkDataStatistics(task.id, 'tenant-ceo', true);
    expect(() =>
      statistics.reviewParkDataStatistics(task.id, 'tenant-ceo', true),
    ).toThrow();
    expect(() =>
      statistics.markParkDataStatisticsRead(task.id, 'other-ceo'),
    ).toThrow();
  });

  it('revokes stale assignments after the enterprise leaves the park', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    const statistics = createParkStatisticsFacade(store);
    const task = createTask(statistics);

    database
      .prepare('UPDATE organizations SET park_id = NULL WHERE id = ?')
      .run('tenant-a');
    expect(statistics.listParkDataStatisticsTasks('tenant-ceo')).toEqual([]);
    expect(() =>
      statistics.markParkDataStatisticsRead(task.id, 'tenant-ceo'),
    ).toThrow();
  });

  it('rejects inactive principals, disabled parks, and disabled features', () => {
    const database = createDatabase();
    const controls = createStore(database);
    const statistics = createParkStatisticsFacade(controls.store);

    expect(() =>
      statistics.listParkDataStatisticsTasks('tenant-disabled-account'),
    ).toThrow();
    expect(() =>
      statistics.createParkDataStatisticsTask({
        createdByAccountId: 'disabled-park-admin',
        title: 'Denied',
        description: 'Denied',
        deadline: '2099-12-31',
      }),
    ).toThrow();
    expect(() =>
      statistics.createParkDataStatisticsTask({
        createdByAccountId: 'disabled-admin',
        title: 'Denied',
        description: 'Denied',
        deadline: '2099-12-31',
      }),
    ).toThrow();

    controls.setFeatureEnabled(false);
    expect(() => statistics.listParkDataStatisticsTasks('park-admin')).toThrow();
    expect(() =>
      statistics.getParkServiceStatistics({
        parkId: 'park-a',
        actorAccountId: 'park-admin',
      }),
    ).toThrow();
  });

  it('rolls back task recipients when audit persistence fails', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    store.audit = () => {
      throw new Error('audit failed');
    };
    const statistics = createParkStatisticsFacade(store);

    expect(() => createTask(statistics)).toThrow('audit failed');
    expect(database.inTransaction).toBe(false);
    expect(
      database.prepare('SELECT COUNT(*) AS total FROM park_data_statistics_tasks')
        .get(),
    ).toEqual({ total: 0 });
    expect(
      database
        .prepare('SELECT COUNT(*) AS total FROM park_data_statistics_assignments')
        .get(),
    ).toEqual({ total: 0 });
  });

  it('aggregates only known services and park tenants with bounded money', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    const statistics = createParkStatisticsFacade(store);
    const insert = database.prepare(
      `INSERT INTO it_tickets
        (id, organization_id, park_id, service_id, form_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'ticket-parking',
      'tenant-a',
      'park-a',
      'parking',
      JSON.stringify({ amountCny: 520, recurringMonthlyCny: 520 }),
      '2026-07-01 09:00:00',
    );
    insert.run(
      'ticket-meeting',
      'tenant-a',
      'park-a',
      'meeting-room',
      JSON.stringify({ amountCny: 100 }),
      '2026-07-02 10:00:00',
    );
    insert.run(
      'ticket-invalid-money',
      'tenant-a',
      'park-a',
      'vehicle-visit',
      JSON.stringify({ amountCny: 1_000_000_001 }),
      '2026-07-03 11:00:00',
    );
    insert.run(
      'ticket-other-park-tenant',
      'tenant-b',
      'park-a',
      'parking',
      JSON.stringify({ amountCny: 999999 }),
      '2026-07-04 12:00:00',
    );
    insert.run(
      'ticket-unknown-service',
      'tenant-a',
      'park-a',
      'unknown-service',
      JSON.stringify({ amountCny: 999999 }),
      '2026-07-05 12:00:00',
    );

    const view = statistics.getParkServiceStatistics({
      parkId: 'park-a',
      actorAccountId: 'park-admin',
    });
    expect(view).toMatchObject({
      parkId: 'park-a',
      generatedAt: '2026-07-28T08:00:00.000Z',
      organizationCount: 3,
      activeOrganizationCount: 1,
      totalServiceUses: 3,
      totalAmountCny: 620,
      recurringMonthlyCny: 520,
      vehicleVisits: 1,
      meetingRoomBookings: 1,
    });
    expect(() =>
      statistics.getParkServiceStatistics({
        parkId: 'park-a',
        actorAccountId: 'tenant-ceo',
      }),
    ).toThrow();
  });
});
