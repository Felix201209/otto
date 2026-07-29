/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSchemaContributor } from '../data_platform/index.js';

export const PARK_RESOURCE_SCHEMA_CONTRIBUTOR: DatabaseSchemaContributor = {
  id: 'park_services_resources',
  apply(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS park_settings (
        organization_id TEXT PRIMARY KEY,
        parking_total INTEGER NOT NULL DEFAULT 0,
        parking_note TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS park_meeting_rooms (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        location TEXT NOT NULL,
        capacity INTEGER NOT NULL,
        equipment TEXT NOT NULL,
        image_url TEXT,
        opening_hours TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS park_meeting_slots (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        meeting_room_id TEXT NOT NULL,
        use_date TEXT NOT NULL,
        slot_key TEXT NOT NULL CHECK(slot_key IN ('morning', 'afternoon')),
        enabled INTEGER NOT NULL DEFAULT 1,
        booked_ticket_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (organization_id, meeting_room_id, use_date, slot_key),
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE CASCADE,
        FOREIGN KEY (meeting_room_id) REFERENCES park_meeting_rooms(id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS park_meeting_bookings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        meeting_room_id TEXT NOT NULL,
        use_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        booked_ticket_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE CASCADE,
        FOREIGN KEY (meeting_room_id) REFERENCES park_meeting_rooms(id)
          ON DELETE CASCADE,
        FOREIGN KEY (booked_ticket_id) REFERENCES it_tickets(id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS park_meeting_slot_overrides (
        organization_id TEXT NOT NULL,
        meeting_room_id TEXT NOT NULL,
        use_date TEXT NOT NULL,
        slot_key TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (organization_id, meeting_room_id, use_date, slot_key),
        FOREIGN KEY (organization_id) REFERENCES organizations(id)
          ON DELETE CASCADE,
        FOREIGN KEY (meeting_room_id) REFERENCES park_meeting_rooms(id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_park_meeting_slots_booked_ticket
        ON park_meeting_slots(booked_ticket_id)
        WHERE booked_ticket_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_park_meeting_rooms_org_enabled
        ON park_meeting_rooms(organization_id, enabled, created_at);
      CREATE INDEX IF NOT EXISTS idx_park_meeting_slots_org_date
        ON park_meeting_slots(organization_id, use_date, meeting_room_id);
      CREATE INDEX IF NOT EXISTS idx_park_meeting_bookings_org_date
        ON park_meeting_bookings(
          organization_id, use_date, meeting_room_id, start_time, end_time
        );
    `);
  },
};
