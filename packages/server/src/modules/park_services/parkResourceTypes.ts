/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface ParkSettingsView {
  parkingTotal: number;
  parkingNote: string | null;
  updatedAt: string;
}

export interface ParkMeetingRoomInput {
  name: string;
  location: string;
  capacity: number;
  equipment?: string[];
  imageUrl?: string | null;
  openingHours?: string | null;
  enabled?: boolean;
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

export interface ParkMeetingSlotView {
  id: string;
  roomId: string;
  date: string;
  slotKey: string;
  label: string;
  status: 'available' | 'booked' | 'closed';
  updatedAt: string;
}

export interface ParkMeetingSlotAvailabilityInput {
  roomId: string;
  date: string;
  slotKey: string;
  enabled: boolean;
}

export interface ParkMeetingPeriodReservationInput {
  roomId: string;
  date: string;
  startTime: string;
  endTime: string;
  ticketId: string;
}

export interface ParkMeetingSlotReservationInput {
  roomId: string;
  date: string;
  slotKey: string;
  ticketId: string;
}

export interface ParkSettingsInput {
  parkingTotal: number;
  parkingNote?: string | null;
}

export const PARK_MEETING_SLOT_MINUTES = 30;
export const PARK_MEETING_OPEN_MINUTES = 9 * 60;
export const PARK_MEETING_CLOSE_MINUTES = 23 * 60;

function meetingClock(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export const PARK_MEETING_TIME_SLOTS = Array.from(
  {
    length:
      (PARK_MEETING_CLOSE_MINUTES - PARK_MEETING_OPEN_MINUTES) /
      PARK_MEETING_SLOT_MINUTES,
  },
  (_, index) => {
    const startMinutes =
      PARK_MEETING_OPEN_MINUTES + index * PARK_MEETING_SLOT_MINUTES;
    const endMinutes = startMinutes + PARK_MEETING_SLOT_MINUTES;
    return {
      key: meetingClock(startMinutes),
      label: `${meetingClock(startMinutes)}-${meetingClock(endMinutes)}`,
      startMinutes,
      endMinutes,
    };
  },
);
