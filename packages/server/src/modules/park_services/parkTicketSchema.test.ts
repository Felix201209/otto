/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import {
  createParkTicketSchemaContributor,
  migrateLegacyParkTicketEvents,
} from './parkTicketSchema.js';

const contributor = createParkTicketSchemaContributor({
  defaultOrganizationId: 'org-default',
});

function createPrerequisites(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE accounts (id TEXT PRIMARY KEY);
    CREATE TABLE parks (
      id TEXT PRIMARY KEY,
      admin_organization_id TEXT NOT NULL,
      FOREIGN KEY (admin_organization_id) REFERENCES organizations(id)
    );
    INSERT INTO organizations (id)
    VALUES ('org-default'), ('org-admin'), ('org-tenant');
    INSERT INTO accounts (id)
    VALUES ('account-creator'), ('account-handler');
    INSERT INTO parks (id, admin_organization_id)
    VALUES ('park-a', 'org-admin');
  `);
}

function insertTicket(database: Database, id = 'ticket-a'): void {
  database.exec(`
    INSERT INTO it_tickets (
      id, organization_id, park_id, application_number,
      created_by_account_id, service_id, title, description, target_tags,
      form_data, status, created_at, updated_at
    ) VALUES (
      '${id}', 'org-tenant', 'park-a', '20260801001',
      'account-creator', 'repair', 'Repair', 'Fix the light', '["repair"]',
      '{"roomNumber":"A-101"}', '已转交',
      '2026-08-01 01:00:00', '2026-08-01 02:00:00'
    );
  `);
}

describe('park ticket schema contributor', () => {
  it('is idempotent and preserves ticket workflow, delivery, and notification data', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      insertTicket(database);
      database.exec(`
        INSERT INTO park_application_sequences
          (park_id, date_key, last_sequence, updated_at)
        VALUES ('park-a', '20260801', 1, '2026-08-01');
        INSERT INTO ticket_events (
          id, organization_id, ticket_id, actor_account_id, action,
          status_before, status_after, response_type, response_text, created_at
        ) VALUES (
          'event-a', 'org-tenant', 'ticket-a', 'account-handler', 'transfer',
          '处理中', '已转交', '工程部', 'Please inspect', '2026-08-01'
        );
        INSERT INTO ticket_deliveries (
          organization_id, ticket_id, account_id, status, delivered_at, read_at
        ) VALUES (
          'org-tenant', 'ticket-a', 'account-handler', 'read',
          '2026-08-01', '2026-08-02'
        );
        INSERT INTO ticket_notifications (
          id, organization_id, ticket_id, recipient_account_id, channel,
          event, status, detail, created_at
        ) VALUES (
          'notification-a', 'org-tenant', 'ticket-a', 'account-handler',
          'feishu', 'ticket_transferred', 'sent', 'delivered', '2026-08-01'
        );
      `);

      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT t.application_number, t.form_data, t.status,
                    e.action, e.response_text, d.status AS delivery_status,
                    d.read_at, n.channel, n.status AS notification_status,
                    n.detail
             FROM it_tickets t
             JOIN ticket_events e ON e.ticket_id = t.id
             JOIN ticket_deliveries d ON d.ticket_id = t.id
             JOIN ticket_notifications n ON n.ticket_id = t.id
             WHERE t.id = 'ticket-a'`,
          )
          .get(),
      ).toEqual({
        application_number: '20260801001',
        form_data: '{"roomNumber":"A-101"}',
        status: '已转交',
        action: 'transfer',
        response_text: 'Please inspect',
        delivery_status: 'read',
        read_at: '2026-08-02',
        channel: 'feishu',
        notification_status: 'sent',
        detail: 'delivered',
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name IN (
               'idx_ticket_deliveries_account',
               'idx_ticket_notifications_ticket',
               'idx_ticket_events_ticket_created',
               'idx_it_tickets_park_org_service_created',
               'idx_it_tickets_park_application_number',
               'idx_ticket_notifications_recipient'
             ) ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_it_tickets_park_application_number' },
        { name: 'idx_it_tickets_park_org_service_created' },
        { name: 'idx_ticket_deliveries_account' },
        { name: 'idx_ticket_events_ticket_created' },
        { name: 'idx_ticket_notifications_recipient' },
        { name: 'idx_ticket_notifications_ticket' },
      ]);
    } finally {
      database.close();
    }
  });

  it('upgrades legacy ticket tables without losing history', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      database.exec(`
        CREATE TABLE it_tickets (
          id TEXT PRIMARY KEY,
          created_by_account_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          target_tags TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE ticket_events (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          ticket_id TEXT NOT NULL,
          actor_account_id TEXT,
          action TEXT NOT NULL CHECK(action IN (
            'created', 'accept', 'respond', 'complete', 'confirm'
          )),
          status_before TEXT,
          status_after TEXT NOT NULL,
          response_type TEXT,
          response_text TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE ticket_deliveries (
          ticket_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          status TEXT NOT NULL,
          delivered_at TEXT NOT NULL,
          read_at TEXT,
          PRIMARY KEY (ticket_id, account_id)
        );
        CREATE TABLE ticket_notifications (
          id TEXT PRIMARY KEY,
          ticket_id TEXT NOT NULL,
          recipient_account_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          event TEXT NOT NULL,
          status TEXT NOT NULL,
          detail TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO it_tickets
          (id, created_by_account_id, title, description, target_tags, status,
           created_at, updated_at)
        VALUES (
          'legacy-ticket', 'account-creator', 'Legacy', 'Preserve me', '[]',
          'open', '2026-07-01', '2026-07-02'
        );
        INSERT INTO ticket_events
        VALUES (
          'legacy-event', 'org-default', 'legacy-ticket', 'account-creator',
          'created', NULL, 'open', NULL, NULL, '2026-07-01'
        );
        INSERT INTO ticket_deliveries
        VALUES (
          'legacy-ticket', 'account-handler', 'delivered', '2026-07-01', NULL
        );
        INSERT INTO ticket_notifications
        VALUES (
          'legacy-notification', 'legacy-ticket', 'account-handler', 'otto',
          'created', 'sent', 'legacy detail', '2026-07-01'
        );
      `);

      migrateLegacyParkTicketEvents(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT organization_id, service_id, status,
                    creator_update_read_at
             FROM it_tickets WHERE id = 'legacy-ticket'`,
          )
          .get(),
      ).toEqual({
        organization_id: 'org-default',
        service_id: 'repair',
        status: '待接单',
        creator_update_read_at: '2026-07-02',
      });
      expect(
        database
          .prepare(
            `SELECT action, status_after FROM ticket_events
             WHERE id = 'legacy-event'`,
          )
          .get(),
      ).toEqual({ action: 'created', status_after: 'open' });
      expect(
        database
          .prepare(
            `SELECT d.organization_id AS delivery_organization_id,
                    n.organization_id AS notification_organization_id,
                    n.detail
             FROM ticket_deliveries d
             JOIN ticket_notifications n ON n.ticket_id = d.ticket_id`,
          )
          .get(),
      ).toEqual({
        delivery_organization_id: 'org-default',
        notification_organization_id: 'org-default',
        detail: 'legacy detail',
      });
      const eventTable = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_events'",
        )
        .get() as { sql: string };
      expect(eventTable.sql).toContain("'transfer'");
      expect(eventTable.sql).toContain("'release'");
      const ticketColumns = new Set(
        (
          database
            .prepare('PRAGMA table_info(it_tickets)')
            .all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
      expect(ticketColumns).toEqual(
        expect.objectContaining(
          new Set([
            'accepted_by_account_id',
            'released_at',
            'release_reason',
            'released_by_account_id',
          ]),
        ),
      );
    } finally {
      database.close();
    }
  });

  it('upgrades a ticket_events table that already has transfer but not release', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      database.exec(`
        CREATE TABLE ticket_events (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          ticket_id TEXT NOT NULL,
          actor_account_id TEXT,
          action TEXT NOT NULL CHECK(action IN (
            'created', 'accept', 'respond', 'complete', 'confirm', 'transfer'
          )),
          status_before TEXT,
          status_after TEXT NOT NULL,
          response_type TEXT,
          response_text TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      migrateLegacyParkTicketEvents(database);
      applyDatabaseSchemaContributors(database, [contributor]);

      const eventTable = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_events'",
        )
        .get() as { sql: string };
      expect(eventTable.sql).toContain("'transfer'");
      expect(eventTable.sql).toContain("'release'");
    } finally {
      database.close();
    }
  });

  it('backfills stable park application numbers and sequence counters', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      database.exec(`
        INSERT INTO it_tickets (
          id, organization_id, park_id, created_by_account_id, service_id,
          title, description, target_tags, status, created_at, updated_at
        ) VALUES
          ('ticket-first', 'org-tenant', 'park-a', 'account-creator', 'parking',
           'First', 'First', '[]', '待接单',
           '2026-07-28 16:00:00', '2026-07-28 16:00:00'),
          ('ticket-second', 'org-tenant', 'park-a', 'account-creator', 'parking',
           'Second', 'Second', '[]', '待接单',
           '2026-07-28 17:00:00', '2026-07-28 17:00:00');
      `);

      applyDatabaseSchemaContributors(database, [contributor]);
      applyDatabaseSchemaContributors(database, [contributor]);

      expect(
        database
          .prepare(
            `SELECT id, application_number FROM it_tickets
             WHERE id LIKE 'ticket-%' ORDER BY created_at`,
          )
          .all(),
      ).toEqual([
        { id: 'ticket-first', application_number: '20260729001' },
        { id: 'ticket-second', application_number: '20260729002' },
      ]);
      expect(
        database
          .prepare(
            `SELECT date_key, last_sequence FROM park_application_sequences
             WHERE park_id = 'park-a'`,
          )
          .get(),
      ).toEqual({ date_key: '20260729', last_sequence: 2 });
    } finally {
      database.close();
    }
  });

  it('enforces constraints and cascades ticket-owned records', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [contributor]);
      insertTicket(database);

      expect(() =>
        database.exec(`
          INSERT INTO park_application_sequences
            (park_id, date_key, last_sequence)
          VALUES ('park-a', '2026081', 1);
        `),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO ticket_events (
            id, organization_id, ticket_id, action, status_after
          ) VALUES ('invalid-event', 'org-tenant', 'ticket-a', 'delete', 'x');
        `),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO ticket_notifications (
            id, organization_id, ticket_id, recipient_account_id, channel,
            event, status
          ) VALUES (
            'invalid-notification', 'org-tenant', 'ticket-a',
            'account-handler', 'email', 'created', 'sent'
          );
        `),
      ).toThrow(/CHECK constraint failed/);

      database.exec(`
        INSERT INTO ticket_events (
          id, organization_id, ticket_id, action, status_after
        ) VALUES ('event-a', 'org-tenant', 'ticket-a', 'created', '待接单');
        INSERT INTO ticket_deliveries
          (organization_id, ticket_id, account_id)
        VALUES ('org-tenant', 'ticket-a', 'account-handler');
        INSERT INTO ticket_notifications (
          id, organization_id, ticket_id, recipient_account_id, channel,
          event, status
        ) VALUES (
          'notification-a', 'org-tenant', 'ticket-a', 'account-handler',
          'otto', 'created', 'sent'
        );
        DELETE FROM it_tickets WHERE id = 'ticket-a';
      `);
      for (const table of [
        'ticket_events',
        'ticket_deliveries',
        'ticket_notifications',
      ]) {
        expect(
          database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
      }
    } finally {
      database.close();
    }
  });

  it('rejects unsafe default organization ids', () => {
    expect(() =>
      createParkTicketSchemaContributor({
        defaultOrganizationId: "org'; DROP TABLE it_tickets; --",
      }),
    ).toThrow('Invalid default organization id for park ticket schema');
  });
});
