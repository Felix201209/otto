/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import { getDB } from './db.js';

export interface ParkSettingsView {
  parkingTotal: number;
  parkingNote: string | null;
  updatedAt: string;
}

export interface ParkMeetingRoomView {
  id: string;
  name: string;
  location: string;
  capacity: number;
  priceHalfDay: number;
  equipment: string[];
  imageUrl: string | null;
  openingHours: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const PARK_MEETING_TIME_SLOTS = [
  { key: 'morning', label: '上午 09:00–12:00' },
  { key: 'afternoon', label: '下午 14:00–18:00' },
] as const;

export interface ParkMeetingSlotView {
  id: string;
  roomId: string;
  date: string;
  slotKey: 'morning' | 'afternoon';
  label: string;
  status: 'available' | 'booked' | 'closed';
  updatedAt: string;
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

function localISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function futureDateRange(days = 30): {
  from: string;
  to: string;
  dates: string[];
} {
  const start = new Date();
  start.setHours(12, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  const dates: string[] = [];
  for (let index = 0; index < days; index += 1) {
    const current = new Date(start);
    current.setDate(start.getDate() + index);
    dates.push(localISODate(current));
  }
  return { from: dates[0]!, to: dates.at(-1)!, dates };
}

function assertFutureMeetingDate(value: string): string {
  const date = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error('请选择有效的预约日期');
  const { from } = futureDateRange(1);
  if (date < from) throw new Error('会议室只能预约未来日期');
  return date;
}

function assertMeetingSlotKey(value: string): 'morning' | 'afternoon' {
  if (value !== 'morning' && value !== 'afternoon')
    throw new Error('请选择有效的使用时段');
  return value;
}

function meetingSlotLabel(slotKey: 'morning' | 'afternoon'): string {
  return PARK_MEETING_TIME_SLOTS.find((slot) => slot.key === slotKey)!.label;
}

function ensureDefaultParkMeetingSlots(organizationId: string): void {
  const rooms = listParkMeetingRooms(organizationId);
  const insert = getDB().prepare(
    `INSERT OR IGNORE INTO park_meeting_slots
      (id, organization_id, meeting_room_id, use_date, slot_key, enabled)
     VALUES (?, ?, ?, ?, ?, 1)`,
  );
  const { dates } = futureDateRange();
  for (const room of rooms) {
    for (const date of dates) {
      for (const slot of PARK_MEETING_TIME_SLOTS) {
        insert.run(
          `park_slot_${randomUUID()}`,
          organizationId,
          room.id,
          date,
          slot.key,
        );
      }
    }
  }
}

export function listParkMeetingSlots(
  organizationId: string,
  fromDate?: string,
  toDate?: string,
): ParkMeetingSlotView[] {
  ensureDefaultParkMeetingSlots(organizationId);
  const defaults = futureDateRange();
  const from = fromDate ? assertFutureMeetingDate(fromDate) : defaults.from;
  const to = toDate ? assertFutureMeetingDate(toDate) : defaults.to;
  if (to < from) throw new Error('预约结束日期不能早于开始日期');
  const rows = getDB()
    .prepare(
      `SELECT id, meeting_room_id, use_date, slot_key, enabled, booked_ticket_id, updated_at
     FROM park_meeting_slots
     WHERE organization_id = ? AND use_date BETWEEN ? AND ?
     ORDER BY use_date, meeting_room_id, slot_key DESC`,
    )
    .all(organizationId, from, to) as Array<{
    id: string;
    meeting_room_id: string;
    use_date: string;
    slot_key: 'morning' | 'afternoon';
    enabled: number;
    booked_ticket_id: string | null;
    updated_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    roomId: row.meeting_room_id,
    date: row.use_date,
    slotKey: row.slot_key,
    label: meetingSlotLabel(row.slot_key),
    status: row.booked_ticket_id
      ? 'booked'
      : row.enabled === 1
        ? 'available'
        : 'closed',
    updatedAt: row.updated_at,
  }));
}

export function setParkMeetingSlotAvailability(
  organizationId: string,
  input: { roomId: string; date: string; slotKey: string; enabled: boolean },
): ParkMeetingSlotView {
  const room = listParkMeetingRooms(organizationId, true).find(
    (item) => item.id === input.roomId,
  );
  if (!room) throw new Error('会议室不存在');
  const date = assertFutureMeetingDate(input.date);
  const slotKey = assertMeetingSlotKey(input.slotKey);
  ensureDefaultParkMeetingSlots(organizationId);
  const current = getDB()
    .prepare(
      `SELECT booked_ticket_id FROM park_meeting_slots
     WHERE organization_id = ? AND meeting_room_id = ? AND use_date = ? AND slot_key = ?`,
    )
    .get(organizationId, room.id, date, slotKey) as
    { booked_ticket_id: string | null } | undefined;
  if (current?.booked_ticket_id) throw new Error('已预约的时间段不能关闭');
  getDB()
    .prepare(
      `INSERT INTO park_meeting_slots
      (id, organization_id, meeting_room_id, use_date, slot_key, enabled)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, meeting_room_id, use_date, slot_key)
     DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`,
    )
    .run(
      `park_slot_${randomUUID()}`,
      organizationId,
      room.id,
      date,
      slotKey,
      input.enabled ? 1 : 0,
    );
  return listParkMeetingSlots(organizationId, date, date).find(
    (slot) => slot.roomId === room.id && slot.slotKey === slotKey,
  )!;
}

export function reserveParkMeetingSlot(
  organizationId: string,
  input: { roomId: string; date: string; slotKey: string; ticketId: string },
): ParkMeetingSlotView {
  const date = assertFutureMeetingDate(input.date);
  const slotKey = assertMeetingSlotKey(input.slotKey);
  ensureDefaultParkMeetingSlots(organizationId);
  const changed = getDB()
    .prepare(
      `UPDATE park_meeting_slots
     SET booked_ticket_id = ?, updated_at = datetime('now')
     WHERE organization_id = ? AND meeting_room_id = ? AND use_date = ? AND slot_key = ?
       AND enabled = 1 AND booked_ticket_id IS NULL`,
    )
    .run(input.ticketId, organizationId, input.roomId, date, slotKey);
  if (changed.changes === 0) {
    const existing = getDB()
      .prepare(
        `SELECT enabled, booked_ticket_id FROM park_meeting_slots
       WHERE organization_id = ? AND meeting_room_id = ? AND use_date = ? AND slot_key = ?`,
      )
      .get(organizationId, input.roomId, date, slotKey) as
      | {
          enabled: number;
          booked_ticket_id: string | null;
        }
      | undefined;
    if (existing?.booked_ticket_id)
      throw new Error('该时间段已被预约，请选择绿色时段');
    throw new Error('该时间段暂不可预约');
  }
  return listParkMeetingSlots(organizationId, date, date).find(
    (slot) => slot.roomId === input.roomId && slot.slotKey === slotKey,
  )!;
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

function normalizeMeetingRoomInput(input: {
  name: string;
  location: string;
  capacity: number;
  equipment?: string[];
  imageUrl?: string | null;
  openingHours?: string | null;
  enabled?: boolean;
}): {
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
      `park_room_${randomUUID()}`,
      organizationId,
      room.name,
      '位置待园区管理员补充',
      room.capacity,
      JSON.stringify(['投屏', '视频会议', '白板']),
      '工作日 09:00–18:00',
    );
  }
}

export function getParkSettings(organizationId: string): ParkSettingsView {
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

export function updateParkSettings(
  organizationId: string,
  input: { parkingTotal: number; parkingNote?: string | null },
): ParkSettingsView {
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

export function listParkMeetingRooms(
  organizationId: string,
  includeDisabled = false,
): ParkMeetingRoomView[] {
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

export function createParkMeetingRoom(
  organizationId: string,
  input: Parameters<typeof normalizeMeetingRoomInput>[0],
): ParkMeetingRoomView {
  const normalized = normalizeMeetingRoomInput(input);
  const id = `park_room_${randomUUID()}`;
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

export function updateParkMeetingRoom(
  organizationId: string,
  id: string,
  input: Parameters<typeof normalizeMeetingRoomInput>[0],
): ParkMeetingRoomView {
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

export function deleteParkMeetingRoom(
  organizationId: string,
  id: string,
): void {
  const changed = getDB()
    .prepare(
      'DELETE FROM park_meeting_rooms WHERE id = ? AND organization_id = ?',
    )
    .run(id, organizationId);
  if (changed.changes === 0) throw new Error('会议室不存在');
}
