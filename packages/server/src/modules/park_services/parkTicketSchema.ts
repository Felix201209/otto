/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type {
  DatabaseHandle,
  DatabaseSchemaContributor,
} from '../data_platform/index.js';

const SAFE_ORGANIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

const TICKET_EVENTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ticket_events (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    ticket_id TEXT NOT NULL,
    actor_account_id TEXT,
    action TEXT NOT NULL CHECK(action IN (
      'created', 'accept', 'release', 'respond', 'complete', 'confirm', 'transfer'
    )),
    status_before TEXT,
    status_after TEXT NOT NULL,
    response_type TEXT,
    response_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
      ON DELETE CASCADE,
    FOREIGN KEY (ticket_id) REFERENCES it_tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_account_id) REFERENCES accounts(id)
  );
`;

function ensureOrganizationColumn(
  database: DatabaseHandle,
  table: string,
  defaultOrganizationId: string,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'organization_id')) {
    database.exec(
      `ALTER TABLE ${table} ADD COLUMN organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}'`,
    );
  }
}

function ensureTicketColumns(database: DatabaseHandle): void {
  const columns = database
    .prepare('PRAGMA table_info(it_tickets)')
    .all() as Array<{ name: string }>;
  const existing = new Set(columns.map((column) => column.name));
  const hadCreatorUpdateReadAt = existing.has('creator_update_read_at');
  for (const name of [
    'park_id',
    'service_id',
    'form_data',
    'category',
    'location',
    'urgency',
    'contact',
    'contact_phone',
    'response_type',
    'response_text',
    'response_at',
    'accepted_at',
    'accepted_by_account_id',
    'released_at',
    'release_reason',
    'released_by_account_id',
    'completed_at',
    'closed_at',
    'application_number',
    'creator_update_at',
    'creator_update_read_at',
  ]) {
    if (!existing.has(name)) {
      database.exec(`ALTER TABLE it_tickets ADD COLUMN ${name} TEXT`);
    }
  }
  if (!hadCreatorUpdateReadAt) {
    database.exec(`
      UPDATE it_tickets
      SET creator_update_at = COALESCE(response_at, completed_at),
          creator_update_read_at = COALESCE(updated_at, created_at)
      WHERE creator_update_read_at IS NULL
    `);
  }
}

function backfillParkApplicationNumbers(database: DatabaseHandle): void {
  const rows = database
    .prepare(
      `SELECT rowid AS ticket_order, id, park_id, application_number,
              created_at,
              strftime('%Y%m%d', created_at, '+8 hours') AS business_date_key
       FROM it_tickets
       WHERE park_id IS NOT NULL
       ORDER BY park_id, created_at, rowid`,
    )
    .all() as Array<{
    ticket_order: number;
    id: string;
    park_id: string;
    application_number: string | null;
    created_at: string;
    business_date_key: string | null;
  }>;
  const lastSequenceByParkDate = new Map<string, number>();
  for (const row of rows) {
    if (!row.application_number) continue;
    if (!/^\d{11}$/.test(row.application_number)) {
      throw new Error(`Invalid park application number on ticket ${row.id}`);
    }
    const dateKey = row.application_number.slice(0, 8);
    const sequence = Number(row.application_number.slice(8));
    if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999) {
      throw new Error(`Invalid park application sequence on ticket ${row.id}`);
    }
    const key = `${row.park_id}:${dateKey}`;
    lastSequenceByParkDate.set(
      key,
      Math.max(lastSequenceByParkDate.get(key) ?? 0, sequence),
    );
  }

  const assign = database.prepare(
    `UPDATE it_tickets SET application_number = ?
     WHERE id = ? AND application_number IS NULL`,
  );
  for (const row of rows) {
    if (row.application_number) continue;
    const dateKey = row.business_date_key;
    if (!dateKey || !/^\d{8}$/.test(dateKey)) {
      throw new Error(`Invalid created_at on park ticket ${row.id}`);
    }
    const key = `${row.park_id}:${dateKey}`;
    const sequence = (lastSequenceByParkDate.get(key) ?? 0) + 1;
    if (sequence > 999) {
      throw new Error(
        `Park ${row.park_id} exceeded 999 applications on ${dateKey}`,
      );
    }
    assign.run(`${dateKey}${String(sequence).padStart(3, '0')}`, row.id);
    lastSequenceByParkDate.set(key, sequence);
  }

  const seedCounter = database.prepare(
    `INSERT INTO park_application_sequences
       (park_id, date_key, last_sequence, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(park_id, date_key) DO UPDATE SET
       last_sequence = MAX(
         park_application_sequences.last_sequence,
         excluded.last_sequence
       ),
       updated_at = datetime('now')`,
  );
  for (const [key, sequence] of lastSequenceByParkDate) {
    const separator = key.lastIndexOf(':');
    seedCounter.run(
      key.slice(0, separator),
      key.slice(separator + 1),
      sequence,
    );
  }
}

export function migrateLegacyParkTicketEvents(database: DatabaseHandle): void {
  const table = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ticket_events'",
    )
    .get() as { sql?: string } | undefined;
  if (
    !table?.sql ||
    (table.sql.includes("'transfer'") && table.sql.includes("'release'"))
  ) return;

  const columns = new Set(
    (
      database.prepare('PRAGMA table_info(ticket_events)').all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  const requiredColumns = [
    'id',
    'organization_id',
    'ticket_id',
    'actor_account_id',
    'action',
    'status_before',
    'status_after',
    'response_type',
    'response_text',
    'created_at',
  ];
  if (!requiredColumns.every((column) => columns.has(column))) return;

  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(
      'ALTER TABLE ticket_events RENAME TO ticket_events_legacy_v10',
    );
    database.exec(TICKET_EVENTS_TABLE_SQL);
    database.exec(`
      INSERT INTO ticket_events (
        id, organization_id, ticket_id, actor_account_id, action,
        status_before, status_after, response_type, response_text, created_at
      )
      SELECT id, organization_id, ticket_id, actor_account_id, action,
             status_before, status_after, response_type, response_text,
             created_at
      FROM ticket_events_legacy_v10;
      DROP TABLE ticket_events_legacy_v10;
      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the migration error.
    }
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}

export function createParkTicketSchemaContributor(input: {
  defaultOrganizationId: string;
}): DatabaseSchemaContributor {
  if (!SAFE_ORGANIZATION_ID.test(input.defaultOrganizationId)) {
    throw new Error('Invalid default organization id for park ticket schema');
  }
  const defaultOrganizationId = input.defaultOrganizationId;

  return {
    id: 'park_services_tickets',
    apply(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS it_tickets (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          park_id TEXT,
          application_number TEXT,
          created_by_account_id TEXT NOT NULL,
          service_id TEXT NOT NULL DEFAULT 'repair',
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
          status TEXT NOT NULL DEFAULT '待接单',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (created_by_account_id) REFERENCES accounts(id),
          FOREIGN KEY (organization_id) REFERENCES organizations(id),
          FOREIGN KEY (park_id) REFERENCES parks(id)
        );

        CREATE TABLE IF NOT EXISTS park_application_sequences (
          park_id TEXT NOT NULL,
          date_key TEXT NOT NULL CHECK(length(date_key) = 8),
          last_sequence INTEGER NOT NULL CHECK(last_sequence BETWEEN 1 AND 999),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (park_id, date_key),
          FOREIGN KEY (park_id) REFERENCES parks(id) ON DELETE CASCADE
        );

        ${TICKET_EVENTS_TABLE_SQL}

        CREATE TABLE IF NOT EXISTS ticket_deliveries (
          organization_id TEXT NOT NULL DEFAULT '${defaultOrganizationId}',
          ticket_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'delivered',
          delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
          read_at TEXT,
          PRIMARY KEY (ticket_id, account_id),
          FOREIGN KEY (ticket_id) REFERENCES it_tickets(id) ON DELETE CASCADE,
          FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );

        CREATE TABLE IF NOT EXISTS ticket_notifications (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          ticket_id TEXT NOT NULL,
          recipient_account_id TEXT NOT NULL,
          channel TEXT NOT NULL CHECK(channel IN ('otto', 'sms', 'feishu')),
          event TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('sent', 'failed', 'skipped')),
          detail TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (ticket_id) REFERENCES it_tickets(id) ON DELETE CASCADE,
          FOREIGN KEY (recipient_account_id) REFERENCES accounts(id)
            ON DELETE CASCADE,
          FOREIGN KEY (organization_id) REFERENCES organizations(id)
        );
      `);

      for (const table of [
        'it_tickets',
        'ticket_deliveries',
        'ticket_notifications',
      ]) {
        ensureOrganizationColumn(database, table, defaultOrganizationId);
      }
      ensureTicketColumns(database);
      database.exec(
        "UPDATE it_tickets SET service_id = 'repair' WHERE service_id IS NULL OR service_id = ''",
      );
      database.exec(
        "UPDATE it_tickets SET status = '待接单' WHERE status = 'open'",
      );
      backfillParkApplicationNumbers(database);

      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_ticket_deliveries_account
          ON ticket_deliveries(account_id, delivered_at);
        CREATE INDEX IF NOT EXISTS idx_ticket_notifications_ticket
          ON ticket_notifications(ticket_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket_created
          ON ticket_events(ticket_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_it_tickets_park_org_service_created
          ON it_tickets(park_id, organization_id, service_id, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_it_tickets_park_application_number
          ON it_tickets(park_id, application_number)
          WHERE park_id IS NOT NULL AND application_number IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_ticket_notifications_recipient
          ON ticket_notifications(recipient_account_id, created_at);
      `);
    },
  };
}
