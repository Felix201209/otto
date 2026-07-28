/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import {
  PARK_MEETING_CLOSE_MINUTES,
  PARK_MEETING_OPEN_MINUTES,
  PARK_MEETING_SLOT_MINUTES,
  PARK_MEETING_TIME_SLOTS,
  type ParkMeetingPeriodReservationInput,
  type ParkMeetingRoomInput,
  type ParkMeetingRoomView,
  type ParkMeetingSlotAvailabilityInput,
  type ParkMeetingSlotReservationInput,
  type ParkMeetingSlotView,
  type ParkSettingsInput,
  type ParkSettingsView,
} from './parkResourceTypes.js';

export interface ParkResourceRepositoryStore {
  db(): Database;
  createMeetingRoomId(): string;
  createMeetingBookingId(): string;
  now?(): Date;
}

const PARK_TIME_ZONE = 'Asia/Shanghai';
const PARK_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(
  'en-CA-u-ca-gregory-nu-latn',
  {
    timeZone: PARK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  },
);

interface ParkDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parkDateTimeParts(date: Date): ParkDateTimeParts {
  const parts = Object.fromEntries(
    PARK_DATE_TIME_FORMATTER.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function parkISODate(date: Date): string {
  const { year, month, day } = parkDateTimeParts(date);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function createParkResourceRepository(
  store: ParkResourceRepositoryStore,
) {
  const getDB = store.db;

  function requireActiveParkResourceOwner(organizationId: string): void {
    const owner = getDB()
      .prepare(
        `SELECT p.id
         FROM parks p
         JOIN organizations o ON o.id = p.admin_organization_id
         WHERE p.admin_organization_id = ?
           AND p.status = 'active'
           AND o.status = 'active'`,
      )
      .get(organizationId) as { id: string } | undefined;
    if (!owner) {
      throw new Error('Current organization is not an active park administrator');
    }
  }

function meetingClock(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

interface ParkMeetingRoomRow {
  id: string;
  name: string;
  location: string;
  capacity: number;
  equipment: string;
  image_url: string | null;
  opening_hours: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function meetingRoomHalfDayPrice(name: string): number {
  if (name.includes('报告厅')) return 800;
  if (name.includes('大会议室') || name.includes('大型会议室')) return 500;
  return 400;
}

function parkMeetingRoomView(row: ParkMeetingRoomRow): ParkMeetingRoomView {
  let equipment: string[] = [];
  try {
    const parsed = JSON.parse(row.equipment) as unknown;
    if (Array.isArray(parsed)) {
      equipment = parsed.filter(
        (item): item is string => typeof item === 'string',
      );
    }
  } catch {
    equipment = [];
  }
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    capacity: Number(row.capacity) || 1,
    priceHalfDay: meetingRoomHalfDayPrice(row.name),
    equipment,
    imageUrl: row.image_url,
    openingHours: row.opening_hours,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function futureDateRange(days = 31, referenceTime = new Date()): {
  from: string;
  to: string;
  dates: string[];
} {
  const { year, month, day } = parkDateTimeParts(referenceTime);
  const dates: string[] = [];
  for (let index = 0; index < days; index += 1) {
    const current = new Date(Date.UTC(year, month - 1, day + index));
    dates.push([
      String(current.getUTCFullYear()).padStart(4, '0'),
      String(current.getUTCMonth() + 1).padStart(2, '0'),
      String(current.getUTCDate()).padStart(2, '0'),
    ].join('-'));
  }
  return { from: dates[0]!, to: dates.at(-1)!, dates };
}

function assertBookableMeetingDate(
  value: string,
  referenceTime = new Date(),
): string {
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error('请选择有效的预约日期');
  const { from } = futureDateRange(1, referenceTime);
  if (date < from) throw new Error('会议室只能预约今天及未来日期');
  return date;
}

function meetingMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error('请选择有效的会议时间');
  return Number(match[1]) * 60 + Number(match[2]);
}

function assertMeetingPeriod(startValue: string, endValue: string): {
  startTime: string;
  endTime: string;
  startMinutes: number;
  endMinutes: number;
} {
  const startMinutes = meetingMinutes(startValue);
  const endMinutes = meetingMinutes(endValue);
  if (
    startMinutes < PARK_MEETING_OPEN_MINUTES
    || endMinutes > PARK_MEETING_CLOSE_MINUTES
    || startMinutes >= endMinutes
    || startMinutes % PARK_MEETING_SLOT_MINUTES !== 0
    || endMinutes % PARK_MEETING_SLOT_MINUTES !== 0
  ) {
    throw new Error('会议时间必须在 09:00-23:00 内，并按 10 分钟选择');
  }
  return {
    startTime: meetingClock(startMinutes),
    endTime: meetingClock(endMinutes),
    startMinutes,
    endMinutes,
  };
}

const LEGACY_MEETING_PERIODS = {
  morning: { startMinutes: 9 * 60, endMinutes: 12 * 60 },
  afternoon: { startMinutes: 14 * 60, endMinutes: 18 * 60 },
} as const;

function listParkMeetingSlots(
  organizationId: string,
  fromDate?: string,
  toDate?: string,
): ParkMeetingSlotView[] {
  requireActiveParkResourceOwner(organizationId);
  const rooms = listParkMeetingRooms(organizationId);
  const referenceTime = store.now?.() ?? new Date();
  const defaults = futureDateRange(31, referenceTime);
  const from = fromDate
    ? assertBookableMeetingDate(fromDate, referenceTime)
    : defaults.from;
  const to = toDate
    ? assertBookableMeetingDate(toDate, referenceTime)
    : defaults.to;
  if (to < from) throw new Error('预约结束日期不能早于开始日期');
  const dates = defaults.dates.filter((date) => date >= from && date <= to);
  const today = parkISODate(referenceTime);
  const parkNow = parkDateTimeParts(referenceTime);
  const currentMinute = parkNow.hour * 60
    + parkNow.minute
    + parkNow.second / 60
    + referenceTime.getMilliseconds() / 60_000;
  const legacyRows = getDB().prepare(
    `SELECT meeting_room_id, use_date, slot_key, enabled, booked_ticket_id, updated_at
     FROM park_meeting_slots
     WHERE organization_id = ? AND use_date BETWEEN ? AND ?`,
  ).all(organizationId, from, to) as Array<{
    meeting_room_id: string;
    use_date: string;
    slot_key: 'morning' | 'afternoon';
    enabled: number;
    booked_ticket_id: string | null;
    updated_at: string;
  }>;
  const bookings = getDB().prepare(
    `SELECT meeting_room_id, use_date, start_time, end_time, created_at
     FROM park_meeting_bookings
     WHERE organization_id = ? AND use_date BETWEEN ? AND ?`,
  ).all(organizationId, from, to) as Array<{
    meeting_room_id: string;
    use_date: string;
    start_time: string;
    end_time: string;
    created_at: string;
  }>;
  const overrides = getDB().prepare(
    `SELECT meeting_room_id, use_date, slot_key, enabled, updated_at
     FROM park_meeting_slot_overrides
     WHERE organization_id = ? AND use_date BETWEEN ? AND ?`,
  ).all(organizationId, from, to) as Array<{
    meeting_room_id: string;
    use_date: string;
    slot_key: string;
    enabled: number;
    updated_at: string;
  }>;

  return rooms.flatMap((room) => dates.flatMap((date) => (
    PARK_MEETING_TIME_SLOTS.map((slot) => {
      const booking = bookings.find((item) => (
        item.meeting_room_id === room.id
        && item.use_date === date
        && meetingMinutes(item.start_time) < slot.endMinutes
        && meetingMinutes(item.end_time) > slot.startMinutes
      ));
      const legacy = legacyRows.find((item) => {
        const period = LEGACY_MEETING_PERIODS[item.slot_key];
        return item.meeting_room_id === room.id
          && item.use_date === date
          && period.startMinutes < slot.endMinutes
          && period.endMinutes > slot.startMinutes;
      });
      const override = overrides.find((item) => (
        item.meeting_room_id === room.id
        && item.use_date === date
        && item.slot_key === slot.key
      ));
      const status = date === today && slot.startMinutes < currentMinute
        ? 'closed'
        : booking || legacy?.booked_ticket_id
        ? 'booked'
        : override?.enabled === 0 || legacy?.enabled === 0
          ? 'closed'
          : 'available';
      return {
        id: `park_slot_${room.id}_${date}_${slot.key.replace(':', '')}`,
        roomId: room.id,
        date,
        slotKey: slot.key,
        label: slot.label,
        status,
        updatedAt: booking?.created_at || override?.updated_at || legacy?.updated_at || room.updatedAt,
      } satisfies ParkMeetingSlotView;
    })
  )));
}

function setParkMeetingSlotAvailability(
  organizationId: string,
  input: ParkMeetingSlotAvailabilityInput,
): ParkMeetingSlotView {
  requireActiveParkResourceOwner(organizationId);
  const room = listParkMeetingRooms(organizationId, true).find(
    (item) => item.id === input.roomId,
  );
  if (!room) throw new Error('会议室不存在');
  const date = assertBookableMeetingDate(
    input.date,
    store.now?.() ?? new Date(),
  );
  const legacyPeriod = LEGACY_MEETING_PERIODS[
    input.slotKey as keyof typeof LEGACY_MEETING_PERIODS
  ];
  const keys = legacyPeriod
    ? PARK_MEETING_TIME_SLOTS.filter((slot) => (
        slot.startMinutes >= legacyPeriod.startMinutes
        && slot.endMinutes <= legacyPeriod.endMinutes
      )).map((slot) => slot.key)
    : [PARK_MEETING_TIME_SLOTS.find((slot) => slot.key === input.slotKey)?.key]
        .filter((key): key is string => Boolean(key));
  if (!keys.length) throw new Error('请选择有效的会议时间');
  const visible = listParkMeetingSlots(organizationId, date, date).filter(
    (slot) => slot.roomId === room.id && keys.includes(slot.slotKey),
  );
  if (!input.enabled && visible.some((slot) => slot.status === 'booked')) {
    throw new Error('已预约的时间段不能关闭');
  }
  const save = getDB().prepare(
    `INSERT INTO park_meeting_slot_overrides
     (organization_id, meeting_room_id, use_date, slot_key, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(organization_id, meeting_room_id, use_date, slot_key)
     DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`,
  );
  for (const key of keys) {
    save.run(organizationId, room.id, date, key, input.enabled ? 1 : 0);
  }
  return listParkMeetingSlots(organizationId, date, date).find(
    (slot) => slot.roomId === room.id && slot.slotKey === keys[0],
  )!;
}

function reserveParkMeetingPeriod(
  organizationId: string,
  input: ParkMeetingPeriodReservationInput,
): ParkMeetingSlotView[] {
  requireActiveParkResourceOwner(organizationId);
  const database = getDB();
  const ownsTransaction = !database.inTransaction;
  if (ownsTransaction) database.exec('BEGIN IMMEDIATE');
  try {
    const slots = reserveParkMeetingPeriodInTransaction(
      organizationId,
      input,
    );
    if (ownsTransaction) database.exec('COMMIT');
    return slots;
  } catch (error) {
    if (ownsTransaction && database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function reserveParkMeetingPeriodInTransaction(
  organizationId: string,
  input: ParkMeetingPeriodReservationInput,
): ParkMeetingSlotView[] {
  const date = assertBookableMeetingDate(
    input.date,
    store.now?.() ?? new Date(),
  );
  const period = assertMeetingPeriod(input.startTime, input.endTime);
  const room = listParkMeetingRooms(organizationId).find((item) => item.id === input.roomId);
  if (!room) throw new Error('会议室不存在');
  const periodSlots = listParkMeetingSlots(organizationId, date, date).filter((slot) => {
    const slotStart = meetingMinutes(slot.slotKey);
    return slot.roomId === room.id
      && slotStart >= period.startMinutes
      && slotStart < period.endMinutes;
  });
  const expectedCount = (period.endMinutes - period.startMinutes) / PARK_MEETING_SLOT_MINUTES;
  if (periodSlots.length !== expectedCount) {
    throw new Error('所选时间包含未开放时段，请重新选择绿色时段');
  }
  if (periodSlots.some((slot) => slot.status === 'booked')) {
    throw new Error('所选时间已被预约，请重新选择绿色时段');
  }
  if (periodSlots.some((slot) => slot.status !== 'available')) {
    throw new Error('所选时间包含未开放时段，请重新选择绿色时段');
  }
  getDB().prepare(
    `INSERT INTO park_meeting_bookings
     (id, organization_id, meeting_room_id, use_date, start_time, end_time, booked_ticket_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    store.createMeetingBookingId(),
    organizationId,
    room.id,
    date,
    period.startTime,
    period.endTime,
    input.ticketId,
  );
  return listParkMeetingSlots(organizationId, date, date).filter((slot) => {
    const slotStart = meetingMinutes(slot.slotKey);
    return slot.roomId === room.id
      && slotStart >= period.startMinutes
      && slotStart < period.endMinutes;
  });
}

function reserveParkMeetingSlot(
  organizationId: string,
  input: ParkMeetingSlotReservationInput,
): ParkMeetingSlotView {
  requireActiveParkResourceOwner(organizationId);
  const legacy = LEGACY_MEETING_PERIODS[
    input.slotKey as keyof typeof LEGACY_MEETING_PERIODS
  ];
  const startTime = legacy ? meetingClock(legacy.startMinutes) : input.slotKey;
  const endTime = legacy
    ? meetingClock(legacy.endMinutes)
    : meetingClock(meetingMinutes(input.slotKey) + PARK_MEETING_SLOT_MINUTES);
  return reserveParkMeetingPeriod(organizationId, {
    roomId: input.roomId,
    date: input.date,
    startTime,
    endTime,
    ticketId: input.ticketId,
  })[0]!;
}

function normalizeMeetingRoomImageUrl(
  value: string | null | undefined,
): string | null {
  const imageUrl = value?.trim() || '';
  if (!imageUrl) return null;
  if (imageUrl.length > 900_000)
    throw new Error('会议室图片过大，请压缩后重试');
  if (
    !/^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=\s]+$/i.test(imageUrl) &&
    !/^https?:\/\/[^\s]+$/i.test(imageUrl)
  ) {
    throw new Error('会议室图片格式不正确');
  }
  return imageUrl;
}

function normalizeMeetingRoomInput(input: ParkMeetingRoomInput): {
  name: string;
  location: string;
  capacity: number;
  equipment: string[];
  imageUrl: string | null;
  openingHours: string | null;
  enabled: boolean;
} {
  const name = input.name.trim().slice(0, 80);
  const location = input.location.trim().slice(0, 120);
  const capacity = Math.floor(Number(input.capacity));
  if (!name || !location) throw new Error('会议室名称和位置不能为空');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
    throw new Error('会议室容纳人数必须在 1–1000 之间');
  }
  const equipment = [
    ...new Set(
      (input.equipment ?? [])
        .map((item) => item.trim().slice(0, 40))
        .filter(Boolean),
    ),
  ].slice(0, 20);
  return {
    name,
    location,
    capacity,
    equipment,
    imageUrl: normalizeMeetingRoomImageUrl(input.imageUrl),
    openingHours: input.openingHours?.trim().slice(0, 120) || null,
    enabled: input.enabled !== false,
  };
}

function ensureDefaultParkMeetingRoom(organizationId: string): void {
  const existing = getDB()
    .prepare(
      'SELECT id FROM park_meeting_rooms WHERE organization_id = ? LIMIT 1',
    )
    .get(organizationId) as { id: string } | undefined;
  if (existing) return;
  const insert = getDB().prepare(
    `INSERT INTO park_meeting_rooms
      (id, organization_id, name, location, capacity, equipment, opening_hours, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const defaults = [
    { name: '中会议室', capacity: 30 },
    { name: '大会议室', capacity: 50 },
    { name: '报告厅', capacity: 80 },
  ];
  for (const room of defaults) {
    insert.run(
      store.createMeetingRoomId(),
      organizationId,
      room.name,
      '位置待园区管理员补充',
      room.capacity,
      JSON.stringify(['投屏', '视频会议', '白板']),
      '每日 09:00–23:00',
    );
  }
}

function getParkSettings(organizationId: string): ParkSettingsView {
  requireActiveParkResourceOwner(organizationId);
  getDB()
    .prepare(
      `INSERT OR IGNORE INTO park_settings (organization_id, parking_total)
     VALUES (?, 0)`,
    )
    .run(organizationId);
  const row = getDB()
    .prepare(
      `SELECT parking_total, parking_note, updated_at
     FROM park_settings WHERE organization_id = ?`,
    )
    .get(organizationId) as {
    parking_total: number;
    parking_note: string | null;
    updated_at: string;
  };
  return {
    parkingTotal: Number(row.parking_total) || 0,
    parkingNote: row.parking_note,
    updatedAt: row.updated_at,
  };
}

function updateParkSettings(
  organizationId: string,
  input: ParkSettingsInput,
): ParkSettingsView {
  requireActiveParkResourceOwner(organizationId);
  const parkingTotal = Math.floor(Number(input.parkingTotal));
  if (
    !Number.isInteger(parkingTotal) ||
    parkingTotal < 0 ||
    parkingTotal > 100_000
  ) {
    throw new Error('总车位数必须是 0–100000 之间的整数');
  }
  getDB()
    .prepare(
      `INSERT INTO park_settings
      (organization_id, parking_total, parking_note, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(organization_id) DO UPDATE SET
       parking_total = excluded.parking_total,
       parking_note = excluded.parking_note,
       updated_at = datetime('now')`,
    )
    .run(
      organizationId,
      parkingTotal,
      input.parkingNote?.trim().slice(0, 500) || null,
    );
  return getParkSettings(organizationId);
}

function listParkMeetingRooms(
  organizationId: string,
  includeDisabled = false,
): ParkMeetingRoomView[] {
  requireActiveParkResourceOwner(organizationId);
  ensureDefaultParkMeetingRoom(organizationId);
  const rows = getDB()
    .prepare(
      `SELECT id, name, location, capacity, equipment, image_url, opening_hours,
            enabled, created_at, updated_at
     FROM park_meeting_rooms
     WHERE organization_id = ? ${includeDisabled ? '' : 'AND enabled = 1'}
     ORDER BY enabled DESC, capacity ASC, created_at ASC`,
    )
    .all(organizationId) as ParkMeetingRoomRow[];
  return rows.map(parkMeetingRoomView);
}

function createParkMeetingRoom(
  organizationId: string,
  input: ParkMeetingRoomInput,
): ParkMeetingRoomView {
  requireActiveParkResourceOwner(organizationId);
  const normalized = normalizeMeetingRoomInput(input);
  const id = store.createMeetingRoomId();
  getDB()
    .prepare(
      `INSERT INTO park_meeting_rooms
      (id, organization_id, name, location, capacity, equipment, image_url,
       opening_hours, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      organizationId,
      normalized.name,
      normalized.location,
      normalized.capacity,
      JSON.stringify(normalized.equipment),
      normalized.imageUrl,
      normalized.openingHours,
      normalized.enabled ? 1 : 0,
    );
  return listParkMeetingRooms(organizationId, true).find(
    (room) => room.id === id,
  )!;
}

function updateParkMeetingRoom(
  organizationId: string,
  id: string,
  input: ParkMeetingRoomInput,
): ParkMeetingRoomView {
  requireActiveParkResourceOwner(organizationId);
  const normalized = normalizeMeetingRoomInput(input);
  const changed = getDB()
    .prepare(
      `UPDATE park_meeting_rooms SET
       name = ?, location = ?, capacity = ?, equipment = ?, image_url = ?,
       opening_hours = ?, enabled = ?, updated_at = datetime('now')
     WHERE id = ? AND organization_id = ?`,
    )
    .run(
      normalized.name,
      normalized.location,
      normalized.capacity,
      JSON.stringify(normalized.equipment),
      normalized.imageUrl,
      normalized.openingHours,
      normalized.enabled ? 1 : 0,
      id,
      organizationId,
    );
  if (changed.changes === 0) throw new Error('会议室不存在');
  return listParkMeetingRooms(organizationId, true).find(
    (room) => room.id === id,
  )!;
}

function deleteParkMeetingRoom(
  organizationId: string,
  id: string,
): void {
  requireActiveParkResourceOwner(organizationId);
  const changed = getDB()
    .prepare(
      'DELETE FROM park_meeting_rooms WHERE id = ? AND organization_id = ?',
    )
    .run(id, organizationId);
  if (changed.changes === 0) throw new Error('会议室不存在');
}

  return {
    createParkMeetingRoom,
    deleteParkMeetingRoom,
    getParkSettings,
    listParkMeetingRooms,
    listParkMeetingSlots,
    reserveParkMeetingPeriod,
    reserveParkMeetingSlot,
    setParkMeetingSlotAvailability,
    updateParkMeetingRoom,
    updateParkSettings,
  };
}
