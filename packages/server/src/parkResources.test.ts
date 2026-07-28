/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Database } from './modules/data_platform/index.js';
import {
  createParkResourceFacade,
  type ParkResourceRepositoryStore,
} from './modules/park_services/index.js';

function createDatabase(): Database {
  const database = new Database(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE parks (
      id TEXT PRIMARY KEY,
      admin_organization_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE park_settings (
      organization_id TEXT PRIMARY KEY,
      parking_total INTEGER NOT NULL DEFAULT 0,
      parking_note TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE park_meeting_rooms (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      location TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      equipment TEXT NOT NULL DEFAULT '[]',
      image_url TEXT,
      opening_hours TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE park_meeting_slots (
      organization_id TEXT NOT NULL,
      meeting_room_id TEXT NOT NULL,
      use_date TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      booked_ticket_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (organization_id, meeting_room_id, use_date, slot_key)
    );
    CREATE TABLE park_meeting_bookings (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      meeting_room_id TEXT NOT NULL,
      use_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      booked_ticket_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE park_meeting_slot_overrides (
      organization_id TEXT NOT NULL,
      meeting_room_id TEXT NOT NULL,
      use_date TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (organization_id, meeting_room_id, use_date, slot_key)
    );

    INSERT INTO organizations (id, status) VALUES
      ('park-admin', 'active'),
      ('ordinary-org', 'active'),
      ('disabled-admin', 'disabled'),
      ('disabled-park-admin', 'active');
    INSERT INTO parks (id, admin_organization_id, status) VALUES
      ('park-active', 'park-admin', 'active'),
      ('park-disabled-org', 'disabled-admin', 'active'),
      ('park-disabled', 'disabled-park-admin', 'disabled');
  `);
  return database;
}

function createStore(database: Database): ParkResourceRepositoryStore {
  let roomSequence = 0;
  let bookingSequence = 0;
  return {
    db: () => database,
    createMeetingRoomId: () => `room-${++roomSequence}`,
    createMeetingBookingId: () => `booking-${++bookingSequence}`,
  };
}

function tomorrow(): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + 1);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function createRoom(
  resources: ReturnType<typeof createParkResourceFacade>,
  enabled = true,
) {
  return resources.createParkMeetingRoom('park-admin', {
    name: enabled ? '创新厅' : '停用会议室',
    location: 'A 座 2 层',
    capacity: 20,
    equipment: ['投屏'],
    enabled,
  });
}

describe('park resource module', () => {
  it('only serves resources owned by an active park administrator', () => {
    const database = createDatabase();
    const resources = createParkResourceFacade(createStore(database));

    expect(resources.updateParkSettings('park-admin', {
      parkingTotal: 120,
      parkingNote: '客服确认',
    })).toMatchObject({ parkingTotal: 120, parkingNote: '客服确认' });
    const room = createRoom(resources);
    expect(room).toMatchObject({ name: '创新厅', capacity: 20 });
    expect(
      resources.listParkMeetingSlots('park-admin', tomorrow(), tomorrow()),
    ).toHaveLength(84);

    expect(() => resources.listParkMeetingRooms('ordinary-org')).toThrow();
    expect(() => resources.getParkSettings('disabled-admin')).toThrow();
    expect(() =>
      resources.createParkMeetingRoom('disabled-park-admin', {
        name: '越权会议室',
        location: '未知',
        capacity: 5,
      }),
    ).toThrow();
  });

  it('commits a direct reservation and rejects overlapping periods', () => {
    const database = createDatabase();
    const resources = createParkResourceFacade(createStore(database));
    const room = createRoom(resources);
    const date = tomorrow();

    const booked = resources.reserveParkMeetingPeriod('park-admin', {
      roomId: room.id,
      date,
      startTime: '09:00',
      endTime: '10:00',
      ticketId: 'ticket-1',
    });
    expect(booked).toHaveLength(6);
    expect(booked.every((slot) => slot.status === 'booked')).toBe(true);
    expect(database.inTransaction).toBe(false);

    expect(() =>
      resources.reserveParkMeetingPeriod('park-admin', {
        roomId: room.id,
        date,
        startTime: '09:30',
        endTime: '10:30',
        ticketId: 'ticket-2',
      }),
    ).toThrow();
    expect(
      database.prepare('SELECT COUNT(*) AS total FROM park_meeting_bookings')
        .get(),
    ).toEqual({ total: 1 });
  });

  it('reuses an existing ticket transaction without committing it', () => {
    const database = createDatabase();
    const resources = createParkResourceFacade(createStore(database));
    const room = createRoom(resources);

    database.exec('BEGIN IMMEDIATE');
    resources.reserveParkMeetingPeriod('park-admin', {
      roomId: room.id,
      date: tomorrow(),
      startTime: '10:00',
      endTime: '11:00',
      ticketId: 'ticket-outer',
    });
    expect(database.inTransaction).toBe(true);
    database.exec('ROLLBACK');
    expect(
      database.prepare('SELECT COUNT(*) AS total FROM park_meeting_bookings')
        .get(),
    ).toEqual({ total: 0 });
  });

  it('does not close booked slots or reserve disabled rooms', () => {
    const database = createDatabase();
    const resources = createParkResourceFacade(createStore(database));
    const room = createRoom(resources);
    const disabledRoom = createRoom(resources, false);
    const date = tomorrow();

    resources.reserveParkMeetingSlot('park-admin', {
      roomId: room.id,
      date,
      slotKey: '09:00',
      ticketId: 'ticket-booked',
    });
    expect(() =>
      resources.setParkMeetingSlotAvailability('park-admin', {
        roomId: room.id,
        date,
        slotKey: '09:00',
        enabled: false,
      }),
    ).toThrow();
    expect(() =>
      resources.reserveParkMeetingSlot('park-admin', {
        roomId: disabledRoom.id,
        date,
        slotKey: '10:00',
        ticketId: 'ticket-disabled-room',
      }),
    ).toThrow();
  });
});
