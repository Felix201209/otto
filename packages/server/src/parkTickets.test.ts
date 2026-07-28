/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createParkTicketFacade,
  normalizeParkServiceFormData,
  type ParkTicketAccount,
  type ParkTicketRepositoryStore,
} from './modules/park_services/index.js';

interface TestAccount extends ParkTicketAccount {
  department: string | null;
  tags: string[];
}

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      park_id TEXT
    );
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      employee_id TEXT,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      is_admin INTEGER NOT NULL,
      status TEXT NOT NULL,
      department TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      deleted_at TEXT
    );
    CREATE TABLE parks (
      id TEXT PRIMARY KEY,
      admin_organization_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE park_services (
      park_id TEXT NOT NULL,
      id TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      PRIMARY KEY (park_id, id)
    );
    CREATE TABLE park_service_specialists (
      park_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      account_id TEXT NOT NULL
    );
    CREATE TABLE it_tickets (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      park_id TEXT,
      created_by_account_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      target_tags TEXT NOT NULL,
      form_data TEXT,
      category TEXT,
      location TEXT,
      urgency TEXT,
      contact TEXT,
      contact_phone TEXT,
      response_type TEXT,
      response_text TEXT,
      response_at TEXT,
      accepted_at TEXT,
      completed_at TEXT,
      closed_at TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE ticket_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      actor_account_id TEXT,
      action TEXT NOT NULL,
      status_before TEXT,
      status_after TEXT NOT NULL,
      response_type TEXT,
      response_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE ticket_deliveries (
      organization_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'delivered',
      delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
      read_at TEXT,
      PRIMARY KEY (ticket_id, account_id)
    );
    CREATE TABLE ticket_notifications (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      recipient_account_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      event TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO organizations (id, name, status, park_id) VALUES
      ('park-admin-org', 'Park Operator', 'active', 'park-a'),
      ('tenant-a', 'Tenant A', 'active', 'park-a'),
      ('other-org', 'Other Tenant', 'active', 'park-b'),
      ('other-admin-org', 'Other Park Operator', 'active', 'park-b'),
      ('disabled-org', 'Disabled Tenant', 'disabled', 'park-a');
    INSERT INTO parks (id, admin_organization_id, status) VALUES
      ('park-a', 'park-admin-org', 'active'),
      ('park-b', 'other-admin-org', 'active');
    INSERT INTO accounts
      (id, organization_id, employee_id, name, username, is_admin, status, department, tags_json)
    VALUES
      ('tenant-user', 'tenant-a', 'emp-tenant-user', 'Tenant User', 'tenant-user', 0, 'active', 'Sales', '["IT","报修"]'),
      ('tenant-admin', 'tenant-a', 'emp-tenant-admin', 'Tenant Admin', 'tenant-admin', 1, 'active', 'Management', '[]'),
      ('park-admin', 'park-admin-org', 'emp-park-admin', 'Park Admin', 'park-admin', 1, 'active', 'Management', '[]'),
      ('park-worker', 'park-admin-org', 'emp-park-worker', 'Park Worker', 'park-worker', 0, 'active', 'Engineering', '[]'),
      ('park-worker-2', 'park-admin-org', 'emp-park-worker-2', 'Park Worker 2', 'park-worker-2', 0, 'active', 'Engineering', '[]'),
      ('other-worker', 'other-admin-org', 'emp-other-worker', 'Other Worker', 'other-worker', 0, 'active', 'Engineering', '[]'),
      ('disabled-worker', 'park-admin-org', 'emp-disabled-worker', 'Disabled Worker', 'disabled-worker', 0, 'disabled', 'Engineering', '[]');
    INSERT INTO park_services (park_id, id, enabled) VALUES
      ('park-a', 'repair', 1),
      ('park-a', 'parking', 1);
    INSERT INTO park_service_specialists (park_id, service_id, account_id) VALUES
      ('park-a', 'repair', 'park-worker');
  `);
  return database;
}

function createStore(database: Database): {
  store: ParkTicketRepositoryStore<TestAccount>;
  setFeature(organizationId: string, enabled: boolean): void;
  failAudit(): void;
} {
  let ticketSequence = 0;
  let eventSequence = 0;
  let notificationSequence = 0;
  let shouldFailAudit = false;
  const features = new Map<string, boolean>();
  const getAccount = (
    accountId: string,
    organizationId?: string,
  ): TestAccount | null => {
    const row = database.prepare(
      `SELECT * FROM accounts
       WHERE id = ? AND (? IS NULL OR organization_id = ?)
         AND deleted_at IS NULL`,
    ).get(accountId, organizationId ?? null, organizationId ?? null) as
      | {
          id: string;
          organization_id: string;
          employee_id: string | null;
          name: string;
          username: string;
          is_admin: number;
          status: 'active' | 'disabled';
          department: string | null;
          tags_json: string;
        }
      | undefined;
    return row ? {
      id: row.id,
      organizationId: row.organization_id,
      employeeId: row.employee_id,
      name: row.name,
      username: row.username,
      isAdmin: row.is_admin === 1,
      status: row.status,
      department: row.department,
      tags: JSON.parse(row.tags_json) as string[],
    } : null;
  };
  const listOrganizationAccounts = (organizationId: string): TestAccount[] =>
    (database.prepare(
      `SELECT id FROM accounts
       WHERE organization_id = ? AND deleted_at IS NULL ORDER BY id`,
    ).all(organizationId) as Array<{ id: string }>)
      .map((row) => getAccount(row.id))
      .filter((account): account is TestAccount => account !== null);
  const store: ParkTicketRepositoryStore<TestAccount> = {
    db: () => database,
    getAccount,
    isOrganizationActive: (organizationId) => Boolean(database.prepare(
      "SELECT 1 FROM organizations WHERE id = ? AND status = 'active'",
    ).get(organizationId)),
    getOrganizationFeatures: (organizationId) => ({
      park_service: features.get(organizationId) ?? true,
    }),
    getPark: (parkId) => {
      const row = database.prepare(
        'SELECT id, admin_organization_id, status FROM parks WHERE id = ?',
      ).get(parkId) as
        | {
            id: string;
            admin_organization_id: string;
            status: 'active' | 'disabled';
          }
        | undefined;
      return row ? {
        id: row.id,
        adminOrganizationId: row.admin_organization_id,
        status: row.status,
      } : null;
    },
    getParkForOrganization: (organizationId) => {
      const row = database.prepare(
        'SELECT park_id FROM organizations WHERE id = ?',
      ).get(organizationId) as { park_id: string | null } | undefined;
      return row?.park_id ? store.getPark(row.park_id) : null;
    },
    listParkServices: (parkId) => database.prepare(
      'SELECT id, enabled FROM park_services WHERE park_id = ? ORDER BY id',
    ).all(parkId).map((row) => {
      const service = row as { id: string; enabled: number };
      return { id: service.id, enabled: service.enabled === 1 };
    }),
    listParkServiceSpecialists: (parkId) => database.prepare(
      `SELECT service_id, account_id FROM park_service_specialists
       WHERE park_id = ? ORDER BY account_id`,
    ).all(parkId).map((row) => {
      const specialist = row as { service_id: string; account_id: string };
      return {
        serviceId: specialist.service_id,
        accountId: specialist.account_id,
      };
    }),
    listActiveOrganizationAdmins: (organizationId) =>
      listOrganizationAccounts(organizationId).filter(
        (account) => account.isAdmin && account.status === 'active',
      ),
    listActiveAccountsByDepartment: (
      organizationId,
      department,
      excludeAccountId,
    ) => listOrganizationAccounts(organizationId).filter(
      (account) => account.status === 'active'
        && account.department === department
        && account.id !== excludeAccountId,
    ),
    listActiveAccountsByTags: (organizationId, tags) =>
      listOrganizationAccounts(organizationId).filter(
        (account) => account.status === 'active'
          && tags.every((tag) => account.tags.includes(tag)),
      ),
    normalizeTags: (tags) => [...new Set(
      (tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    )],
    isParkServiceId: (serviceId) => new Set([
      'renovation',
      'parking',
      'network-phone',
      'meeting-room',
      'electric-card',
      'repair',
      'vehicle-visit',
    ]).has(serviceId),
    createTicketId: () => `ticket-${++ticketSequence}`,
    createTicketEventId: () => `ticket-event-${++eventSequence}`,
    createTicketNotificationId: () =>
      `ticket-notification-${++notificationSequence}`,
    audit: () => {
      if (shouldFailAudit) throw new Error('audit unavailable');
    },
  };
  return {
    store,
    setFeature: (organizationId, enabled) => {
      features.set(organizationId, enabled);
    },
    failAudit: () => {
      shouldFailAudit = true;
    },
  };
}

function repairInput() {
  return {
    createdByAccountId: 'tenant-user',
    serviceId: 'repair',
    title: 'Water leak',
    description: 'Pipe is leaking',
    formData: {
      company: 'Tenant A',
      roomNumber: '5-101',
      contact: 'Alice',
      phone: '13800138000',
      category: '给排水维修',
      issue: 'Pipe is leaking',
      urgency: '紧急',
    },
  };
}

describe('park ticket module', () => {
  it('routes park tickets to active specialists and falls back to active admins', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    const tickets = createParkTicketFacade(store);

    const first = tickets.createTicket(repairInput());
    expect(first.recipients).toEqual([{ id: 'park-worker', name: 'Park Worker' }]);
    expect(first.history.map((event) => event.action)).toEqual(['created']);

    database.prepare("UPDATE accounts SET status = 'disabled' WHERE id = 'park-worker'").run();
    const second = tickets.createTicket(repairInput());
    expect(second.recipients).toEqual([{ id: 'park-admin', name: 'Park Admin' }]);
  });

  it('rolls back the ticket, initial event and deliveries when audit fails', () => {
    const database = createDatabase();
    const { store, failAudit } = createStore(database);
    const tickets = createParkTicketFacade(store);
    failAudit();

    expect(() => tickets.createTicket(repairInput())).toThrow('audit unavailable');
    expect(database.prepare('SELECT COUNT(*) AS count FROM it_tickets').get())
      .toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM ticket_events').get())
      .toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM ticket_deliveries').get())
      .toEqual({ count: 0 });
  });

  it('fails closed for unrelated, disabled and feature-revoked accounts', () => {
    const database = createDatabase();
    const { store, setFeature } = createStore(database);
    const tickets = createParkTicketFacade(store);
    const ticket = tickets.createTicket(repairInput());

    expect(tickets.getTicketForAccount(ticket.id, 'other-worker')).toBeNull();
    expect(tickets.getTicketForAccount(ticket.id, 'park-worker')).not.toBeNull();
    database.prepare("UPDATE accounts SET status = 'disabled' WHERE id = 'park-worker'").run();
    expect(tickets.getTicketForAccount(ticket.id, 'park-worker')).toBeNull();
    database.prepare("UPDATE accounts SET status = 'active' WHERE id = 'park-worker'").run();
    setFeature('tenant-a', false);
    expect(tickets.getTicketForAccount(ticket.id, 'park-worker')).not.toBeNull();
    expect(
      tickets.isTicketFeatureEnabledForAccount(ticket.id, 'park-worker'),
    ).toBe(false);
    expect(() => tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'accept',
    })).toThrow('园区服务功能已由管理员关闭');
    expect(() => tickets.createTicket(repairInput())).toThrow('园区服务功能已由管理员关闭');
    setFeature('tenant-a', true);
    database.prepare("UPDATE parks SET status = 'disabled' WHERE id = 'park-a'").run();
    expect(tickets.getTicketForAccount(ticket.id, 'park-worker')).toBeNull();
    expect(tickets.getTicketNotificationRecipients(ticket.id)).toEqual([]);
  });

  it('limits repair transfer to the park operator and revokes the old worker', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    const tickets = createParkTicketFacade(store);
    const ticket = tickets.createTicket(repairInput());

    expect(() => tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'transfer',
      transferAccountId: 'other-worker',
    })).toThrow('请选择有效的转交同事或部门');

    const transferred = tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'transfer',
      transferAccountId: 'park-worker-2',
    });
    expect(transferred.status).toBe('已转交');
    expect(() => tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'respond',
      responseType: '处理中',
      responseText: 'Old worker must no longer update',
    })).toThrow('Only the currently assigned worker can update');

    const completed = tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker-2',
      action: 'complete',
    });
    expect(completed.status).toBe('已完成');
    expect(completed.history.map((event) => event.action)).toEqual([
      'created',
      'transfer',
      'complete',
    ]);
  });

  it('only records notifications for the creator or assigned recipients', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    const tickets = createParkTicketFacade(store);
    const ticket = tickets.createTicket(repairInput());

    tickets.recordTicketNotification({
      ticketId: ticket.id,
      recipientAccountId: 'tenant-user',
      channel: 'otto',
      event: 'updated',
      status: 'sent',
    });
    tickets.recordTicketNotification({
      ticketId: ticket.id,
      recipientAccountId: 'park-worker',
      channel: 'otto',
      event: 'created',
      status: 'sent',
    });
    expect(() => tickets.recordTicketNotification({
      ticketId: ticket.id,
      recipientAccountId: 'other-worker',
      channel: 'otto',
      event: 'created',
      status: 'sent',
    })).toThrow('Notification recipient is not assigned');
  });

  it('keeps pricing and ten-minute meeting rules in the form-rules layer', () => {
    const common = {
      company: 'Tenant A',
      roomNumber: '5-101',
      contact: 'Alice',
      phone: '13800138000',
    };
    const parking = normalizeParkServiceFormData('parking', {
      ...common,
      applicationType: 'underground-fixed',
      quantity: '2',
    });
    expect(parking.amountCny).toBe('520');
    expect(parking.recurringMonthlyCny).toBe('520');
    expect(() => normalizeParkServiceFormData('meeting-room', {
      ...common,
      attendees: '4',
      roomId: 'room-a',
      date: '2026-07-29',
      startTime: '09:05',
      endTime: '10:00',
      priceHalfDay: '200',
    })).toThrow('并按 10 分钟选择');
  });
});
