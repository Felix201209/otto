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
      application_number TEXT,
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
      accepted_by_account_id TEXT,
      released_at TEXT,
      release_reason TEXT,
      released_by_account_id TEXT,
      completed_at TEXT,
      closed_at TEXT,
      creator_update_at TEXT,
      creator_update_read_at TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE park_application_sequences (
      park_id TEXT NOT NULL,
      date_key TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (park_id, date_key)
    );
    CREATE UNIQUE INDEX idx_it_tickets_park_application_number
      ON it_tickets(park_id, application_number)
      WHERE park_id IS NOT NULL AND application_number IS NOT NULL;
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
      ('park-worker', 'park-admin-org', 'emp-park-worker', 'Park Worker', 'park-worker', 0, 'active', '客服部', '[]'),
      ('park-worker-2', 'park-admin-org', 'emp-park-worker-2', 'Park Worker 2', 'park-worker-2', 0, 'active', '工程部', '[]'),
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
  setNow(value: Date): void;
} {
  let ticketSequence = 0;
  let eventSequence = 0;
  let notificationSequence = 0;
  let shouldFailAudit = false;
  let now = new Date('2026-07-28T04:00:00Z');
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
    now: () => new Date(now),
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
    setNow: (value) => {
      now = new Date(value);
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
  it('allocates a daily park-wide application number across services without duplicates', () => {
    const database = createDatabase();
    const { store, setNow } = createStore(database);
    const tickets = createParkTicketFacade(store);

    const first = tickets.createTicket(repairInput());
    const second = tickets.createTicket({
      createdByAccountId: 'tenant-user',
      serviceId: 'parking',
      title: 'Parking request',
      description: 'Apply for one parking space',
      formData: {
        company: 'Tenant A',
        roomNumber: '5-101',
        contact: 'Alice',
        phone: '13800138000',
        applicationType: 'underground-fixed',
        quantity: '1',
      },
    });
    const sameDay = Array.from({ length: 20 }, () =>
      tickets.createTicket(repairInput()).applicationNumber,
    );

    expect(first.applicationNumber).toBe('20260728001');
    expect(second.applicationNumber).toBe('20260728002');
    expect(new Set(sameDay).size).toBe(20);
    expect(sameDay.at(-1)).toBe('20260728022');

    setNow(new Date('2026-07-28T16:01:00Z'));
    expect(tickets.createTicket(repairInput()).applicationNumber).toBe(
      '20260729001',
    );
  });

  it('uses the Asia/Shanghai business day for application numbers at midnight', () => {
    const database = createDatabase();
    const { store, setNow } = createStore(database);
    const tickets = createParkTicketFacade(store);

    setNow(new Date('2026-07-28T15:59:59Z'));
    expect(tickets.createTicket(repairInput()).applicationNumber).toBe(
      '20260728001',
    );
    setNow(new Date('2026-07-28T16:00:00Z'));
    expect(tickets.createTicket(repairInput()).applicationNumber).toBe(
      '20260729001',
    );
  });

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
    expect(database.prepare('SELECT COUNT(*) AS count FROM park_application_sequences').get())
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

  it('requires customer service to reply and transfer to engineering atomically without choosing a person', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    const tickets = createParkTicketFacade(store);
    const ticket = tickets.createTicket(repairInput());

    database.prepare(
      "UPDATE accounts SET status = 'disabled' WHERE id = 'park-worker-2'",
    ).run();
    expect(() => tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'respond_and_transfer',
      responseType: '已受理',
      responseText: '客服已确认报修内容',
    })).toThrow(/工程部暂无可接收/);
    expect(tickets.getTicketForAccount(ticket.id, 'park-worker')).toMatchObject({
      status: '待接单',
      responseType: null,
      responseText: null,
      history: [expect.objectContaining({ action: 'created' })],
    });
    database.prepare(
      "UPDATE accounts SET status = 'active' WHERE id = 'park-worker-2'",
    ).run();

    expect(() => tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'transfer',
      transferAccountId: 'park-worker-2',
    } as never)).toThrow(/工单操作不正确/);

    expect(() => tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'respond_and_transfer',
      transferAccountId: 'park-worker-2',
      responseType: '已受理',
      responseText: '客服已确认报修内容',
    })).toThrow(/不能指定个人/);

    const transferred = tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'respond_and_transfer',
      responseType: '已受理',
      responseText: '客服已确认报修内容',
      transferDepartment: '工程部',
      transferNote: '请工程部上门检查并记录处理结果',
    });
    expect(transferred.status).toBe('已转交');
    expect(transferred.history.map((event) => event.action)).toEqual([
      'created',
      'respond',
      'transfer',
    ]);
    expect(transferred.history.at(-2)).toMatchObject({
      action: 'respond',
      responseType: '已受理',
      responseText: '客服已确认报修内容',
    });
    expect(transferred.history.at(-1)).toMatchObject({
      action: 'transfer',
      responseType: '已转交至工程部',
      responseText: '请工程部上门检查并记录处理结果',
    });
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
      'respond',
      'transfer',
      'complete',
    ]);
    expect(
      tickets.getTicketForAccount(ticket.id, 'park-worker'),
    ).toMatchObject({
      status: '已完成',
      responseType: '现场工作已完成',
      responseText: '工作人员已完成转交事项。',
    });
  });

  it('keeps creator progress unread across transfer until the creator explicitly reads it', () => {
    const database = createDatabase();
    const { store } = createStore(database);
    const tickets = createParkTicketFacade(store);
    const ticket = tickets.createTicket(repairInput());

    expect(ticket.creatorUpdateAt).toBeNull();
    expect(ticket.creatorUpdateReadAt).toEqual(expect.any(String));
    const updated = tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'respond_and_transfer',
      responseType: '客服已受理',
      responseText: '已核实并转交工程部。',
      transferNote: '请工程部上门处理。',
    });
    expect(updated.creatorUpdateAt).toEqual(expect.any(String));
    expect(updated.creatorUpdateReadAt).toBeNull();
    expect(
      database.prepare(
        'SELECT status, read_at FROM ticket_deliveries WHERE ticket_id = ? AND account_id = ?',
      ).get(ticket.id, 'park-worker'),
    ).toEqual({ status: 'transferred', read_at: null });

    expect(
      tickets.getTicketForAccount(ticket.id, 'tenant-user')
        ?.creatorUpdateReadAt,
    ).toBeNull();
    expect(
      tickets.markTicketRead(ticket.id, 'tenant-user').creatorUpdateReadAt,
    ).toEqual(expect.any(String));

    tickets.markTicketRead(ticket.id, 'park-worker');
    expect(
      database.prepare(
        'SELECT status, read_at FROM ticket_deliveries WHERE ticket_id = ? AND account_id = ?',
      ).get(ticket.id, 'park-worker'),
    ).toEqual({ status: 'transferred', read_at: expect.any(String) });
    const completed = tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker-2',
      action: 'complete',
      responseType: '现场工作已完成',
      responseText: '已完成检修。',
    });
    expect(completed.creatorUpdateAt).toEqual(expect.any(String));
    expect(completed.creatorUpdateReadAt).toBeNull();
    expect(
      database.prepare(
        'SELECT status, read_at FROM ticket_deliveries WHERE ticket_id = ? AND account_id = ?',
      ).get(ticket.id, 'park-worker'),
    ).toEqual({ status: 'transferred', read_at: null });
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

  it('keeps pricing and 30-minute meeting rules in the form-rules layer', () => {
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
    expect(normalizeParkServiceFormData('electric-card', {
      ...common,
      chargingKwh: '12.5',
    })).toMatchObject({
      chargingKwh: '12.5',
      unitPriceCny: '1.2',
      pricing: '1.2元/度',
      amountCny: '15',
    });
    expect(normalizeParkServiceFormData('electric-card', {
      ...common,
      amount: '10',
    })).toMatchObject({
      chargingKwh: '8.33',
      unitPriceCny: '1.2',
      pricing: '1.2元/度',
      amountCny: '10',
    });
    const firstMeeting = normalizeParkServiceFormData('meeting-room', {
      ...common,
      attendees: '4',
      roomId: 'room-a',
      date: '2026-07-29',
      meetingContent: '企业 A 会议',
      startTime: '09:00',
      endTime: '09:30',
      priceHalfDay: '400',
    });
    const secondMeeting = normalizeParkServiceFormData('meeting-room', {
      ...common,
      attendees: '3',
      roomId: 'room-a',
      date: '2026-07-29',
      meetingContent: '企业 B 会议',
      startTime: '09:30',
      endTime: '10:00',
      priceHalfDay: '400',
    });
    expect(firstMeeting).toMatchObject({
      amountCny: '400',
      pricing: '400元/半天，不足半天按半天计',
    });
    expect(secondMeeting).toMatchObject({
      amountCny: '400',
      pricing: '400元/半天，不足半天按半天计',
    });
    expect(() => normalizeParkServiceFormData('vehicle-visit', {
      ...common,
      visitDate: '2026-07-29',
      reason: '客户来访',
      vehicleCount: '1',
      plate1: '京A12345',
    })).toThrow('来访时间');
    expect(() => normalizeParkServiceFormData('vehicle-visit', {
      ...common,
      visitDate: '2026-07-29',
      visitTime: '9:30',
      reason: '客户来访',
      vehicleCount: '1',
      plate1: '京A12345',
    })).toThrow('来访时间');
    expect(() => normalizeParkServiceFormData('meeting-room', {
      ...common,
      attendees: '4',
      roomId: 'room-a',
      date: '2026-07-29',
      startTime: '09:00',
      endTime: '10:00',
      priceHalfDay: '200',
    })).toThrow('会议内容');
    expect(() => normalizeParkServiceFormData('meeting-room', {
      ...common,
      attendees: '4',
      roomId: 'room-a',
      date: '2026-07-29',
      meetingContent: '测试会议',
      startTime: '09:05',
      endTime: '10:00',
      priceHalfDay: '200',
    })).toThrow('并按 30 分钟选择');
  });

  it('round-trips a validated vehicle visit time through the ticket view', () => {
    const database = createDatabase();
    database.exec(
      "INSERT INTO park_services (park_id, id, enabled) VALUES ('park-a', 'vehicle-visit', 1)",
    );
    const { store } = createStore(database);
    const ticket = createParkTicketFacade(store).createTicket({
      createdByAccountId: 'tenant-user',
      serviceId: 'vehicle-visit',
      title: '访客车辆登记',
      description: '客户来访',
      formData: {
        company: 'Tenant A',
        roomNumber: '5-101',
        contact: 'Alice',
        phone: '13800138000',
        visitDate: '2026-07-29',
        visitTime: '09:30',
        reason: '客户来访',
        vehicleCount: '1',
        plate1: '京A12345',
      },
    });

    expect(ticket.formData.visitTime).toBe('09:30');
  });

  it('routes a ticket to every matching specialist so the pool can race to claim it', () => {
    const database = createDatabase();
    database.prepare(
      "INSERT INTO park_service_specialists (park_id, service_id, account_id) VALUES ('park-a', 'repair', 'park-worker-2')",
    ).run();
    const { store } = createStore(database);
    const tickets = createParkTicketFacade(store);
    const ticket = tickets.createTicket(repairInput());
    expect(ticket.recipients.map((item) => item.id).sort()).toEqual([
      'park-worker',
      'park-worker-2',
    ]);
  });

  it('only one worker wins the claim and everyone else gets a stable already-claimed error', () => {
    const database = createDatabase();
    database.prepare(
      "INSERT INTO park_service_specialists (park_id, service_id, account_id) VALUES ('park-a', 'repair', 'park-worker-2')",
    ).run();
    const { store } = createStore(database);
    const tickets = createParkTicketFacade(store);
    const ticket = tickets.createTicket(repairInput());

    let succeeded = 0;
    const failures: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const accountId = i % 2 === 0 ? 'park-worker' : 'park-worker-2';
      try {
        const claimed = tickets.updateTicket({
          ticketId: ticket.id,
          accountId,
          action: 'accept',
        });
        succeeded += 1;
        expect(claimed.acceptedBy).toEqual(
          accountId === 'park-worker'
            ? { id: 'park-worker', name: 'Park Worker' }
            : { id: 'park-worker-2', name: 'Park Worker 2' },
        );
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    expect(succeeded).toBe(1);
    expect(failures).toHaveLength(99);
    expect(
      failures.every((message) =>
        message === '工单已被他人接单' || message === '工单已由您接单',
      ),
    ).toBe(true);

    const stored = database.prepare(
      'SELECT status, accepted_by_account_id FROM it_tickets WHERE id = ?',
    ).get(ticket.id) as { status: string; accepted_by_account_id: string | null };
    expect(stored.status).toBe('维修中');
    expect(stored.accepted_by_account_id).toBeTruthy();
  });

  it('allows the handler to release the ticket back to the pool and another worker to re-claim', () => {
    const database = createDatabase();
    database.prepare(
      "INSERT INTO park_service_specialists (park_id, service_id, account_id) VALUES ('park-a', 'repair', 'park-worker-2')",
    ).run();
    const { store } = createStore(database);
    const tickets = createParkTicketFacade(store);
    const ticket = tickets.createTicket(repairInput());

    const claimed = tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'accept',
    });
    expect(claimed.status).toBe('维修中');
    expect(claimed.acceptedBy).toEqual({ id: 'park-worker', name: 'Park Worker' });
    expect(claimed.history.map((event) => event.action)).toEqual(['created', 'accept']);

    // 只有当前处理人可以退回；非处理人拒绝。
    expect(() => tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker-2',
      action: 'release',
      releaseReason: '忙不过来',
    })).toThrow('只有当前处理人可以退回工单');

    const released = tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'release',
      releaseReason: '暂时没空',
    });
    expect(released.status).toBe('待接单');
    expect(released.acceptedBy).toBeNull();
    expect(released.releasedAt).toEqual(expect.any(String));
    expect(released.releaseReason).toBe('暂时没空');
    expect(released.history.map((event) => event.action)).toEqual([
      'created',
      'accept',
      'release',
    ]);

    // 退回后可由其他符合条件的人员重新接单。
    const reClaimed = tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker-2',
      action: 'accept',
    });
    expect(reClaimed.status).toBe('维修中');
    expect(reClaimed.acceptedBy).toEqual({ id: 'park-worker-2', name: 'Park Worker 2' });
    expect(reClaimed.history.map((event) => event.action)).toEqual([
      'created',
      'accept',
      'release',
      'accept',
    ]);
  });

  it('never allows re-claiming a completed ticket, a non-specialist, or a cross-enterprise account', () => {
    const database = createDatabase();
    database.prepare(
      "INSERT INTO park_service_specialists (park_id, service_id, account_id) VALUES ('park-a', 'repair', 'park-worker-2')",
    ).run();
    const { store } = createStore(database);
    const tickets = createParkTicketFacade(store);
    const ticket = tickets.createTicket(repairInput());

    const claimed = tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'accept',
    });
    expect(claimed.status).toBe('维修中');
    tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker',
      action: 'complete',
    });
    const confirmed = tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'tenant-user',
      action: 'confirm',
    });
    expect(confirmed.status).toBe('已完成');

    // 已完成工单不可重抢：同为待办池成员的另一名专员也不能再抢。
    expect(() => tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'park-worker-2',
      action: 'accept',
    })).toThrow('工单已被他人接单');

    // 非专员（创建者）不可抢单。
    expect(() => tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'tenant-user',
      action: 'accept',
    })).toThrow('Only the currently assigned worker can update');

    // 跨企业账号不可见工单，更不可抢单。
    expect(tickets.getTicketForAccount(ticket.id, 'other-worker')).toBeNull();
    expect(() => tickets.updateTicket({
      ticketId: ticket.id,
      accountId: 'other-worker',
      action: 'accept',
    })).toThrow('Ticket not found');
  });
});
