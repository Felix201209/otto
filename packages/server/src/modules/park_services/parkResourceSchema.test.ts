/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSchemaContributors,
  Database,
} from '../data_platform/index.js';
import { PARK_RESOURCE_SCHEMA_CONTRIBUTOR } from './parkResourceSchema.js';

function createPrerequisites(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE it_tickets (id TEXT PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('org-admin'), ('org-other');
    INSERT INTO it_tickets (id) VALUES ('ticket-a'), ('ticket-b');
  `);
}

function insertResourceHistory(database: Database): void {
  database.exec(`
    INSERT INTO park_settings
      (organization_id, parking_total, parking_note, updated_at)
    VALUES ('org-admin', 120, 'Basement spaces', '2026-08-01');
    INSERT INTO park_meeting_rooms (
      id, organization_id, name, location, capacity, equipment, image_url,
      opening_hours, enabled, created_at, updated_at
    ) VALUES (
      'room-a', 'org-admin', 'Innovation Hall', 'Building A', 20,
      '["screen"]', 'room.png', '09:00-23:00', 1,
      '2026-08-01', '2026-08-02'
    );
    INSERT INTO park_meeting_slots (
      id, organization_id, meeting_room_id, use_date, slot_key, enabled,
      booked_ticket_id, created_at, updated_at
    ) VALUES (
      'legacy-slot-a', 'org-admin', 'room-a', '2026-08-10', 'morning', 0,
      NULL, '2026-08-01', '2026-08-02'
    );
    INSERT INTO park_meeting_bookings (
      id, organization_id, meeting_room_id, use_date, start_time, end_time,
      booked_ticket_id, created_at
    ) VALUES (
      'booking-a', 'org-admin', 'room-a', '2026-08-11', '09:10', '10:00',
      'ticket-a', '2026-08-03'
    );
    INSERT INTO park_meeting_slot_overrides (
      organization_id, meeting_room_id, use_date, slot_key, enabled, updated_at
    ) VALUES (
      'org-admin', 'room-a', '2026-08-12', '09:20', 0, '2026-08-04'
    );
  `);
}

describe('park resource schema contributor', () => {
  it('is idempotent and preserves settings, legacy slots, and bookings', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        PARK_RESOURCE_SCHEMA_CONTRIBUTOR,
      ]);
      insertResourceHistory(database);

      applyDatabaseSchemaContributors(database, [
        PARK_RESOURCE_SCHEMA_CONTRIBUTOR,
      ]);

      expect(
        database
          .prepare(
            `SELECT s.parking_total, s.parking_note, r.name, r.opening_hours,
                    l.slot_key AS legacy_slot_key, l.enabled AS legacy_enabled,
                    b.start_time, b.end_time, b.booked_ticket_id,
                    o.slot_key AS override_slot_key,
                    o.enabled AS override_enabled
             FROM park_settings s
             JOIN park_meeting_rooms r
               ON r.organization_id = s.organization_id
             JOIN park_meeting_slots l ON l.meeting_room_id = r.id
             JOIN park_meeting_bookings b ON b.meeting_room_id = r.id
             JOIN park_meeting_slot_overrides o ON o.meeting_room_id = r.id
             WHERE s.organization_id = 'org-admin'`,
          )
          .get(),
      ).toEqual({
        parking_total: 120,
        parking_note: 'Basement spaces',
        name: 'Innovation Hall',
        opening_hours: '09:00-23:00',
        legacy_slot_key: 'morning',
        legacy_enabled: 0,
        start_time: '09:10',
        end_time: '10:00',
        booked_ticket_id: 'ticket-a',
        override_slot_key: '09:20',
        override_enabled: 0,
      });
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_park_meeting_%'
             ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'idx_park_meeting_bookings_org_date' },
        { name: 'idx_park_meeting_rooms_org_enabled' },
        { name: 'idx_park_meeting_slots_booked_ticket' },
        { name: 'idx_park_meeting_slots_org_date' },
      ]);
    } finally {
      database.close();
    }
  });

  it('enforces legacy period and unique reservation constraints', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        PARK_RESOURCE_SCHEMA_CONTRIBUTOR,
      ]);
      insertResourceHistory(database);

      expect(() =>
        database.exec(`
          INSERT INTO park_meeting_slots (
            id, organization_id, meeting_room_id, use_date, slot_key
          ) VALUES (
            'invalid-slot', 'org-admin', 'room-a', '2026-08-13', 'evening'
          );
        `),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO park_meeting_slots (
            id, organization_id, meeting_room_id, use_date, slot_key
          ) VALUES (
            'duplicate-slot', 'org-admin', 'room-a', '2026-08-10', 'morning'
          );
        `),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        database.exec(`
          INSERT INTO park_meeting_bookings (
            id, organization_id, meeting_room_id, use_date, start_time,
            end_time, booked_ticket_id
          ) VALUES (
            'booking-b', 'org-admin', 'room-a', '2026-08-14', '10:00',
            '11:00', 'ticket-a'
          );
        `),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      database.close();
    }
  });

  it('cascades room deletion across slots, bookings, and overrides', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        PARK_RESOURCE_SCHEMA_CONTRIBUTOR,
      ]);
      insertResourceHistory(database);

      database.exec("DELETE FROM park_meeting_rooms WHERE id = 'room-a'");
      for (const table of [
        'park_meeting_slots',
        'park_meeting_bookings',
        'park_meeting_slot_overrides',
      ]) {
        expect(
          database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
        ).toEqual({ count: 0 });
      }
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM park_settings').get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('cascades ticket deletion to its meeting booking', () => {
    const database = new Database(':memory:');
    try {
      createPrerequisites(database);
      applyDatabaseSchemaContributors(database, [
        PARK_RESOURCE_SCHEMA_CONTRIBUTOR,
      ]);
      insertResourceHistory(database);

      database.exec("DELETE FROM it_tickets WHERE id = 'ticket-a'");
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM park_meeting_bookings')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
