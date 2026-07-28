/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

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
    hourCycle: 'h23',
  },
);

interface ParkDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
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
  };
}

export function parkISODate(
  date = new Date(),
  offsetDays = 0,
): string {
  const { year, month, day } = parkDateTimeParts(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return [
    String(shifted.getUTCFullYear()).padStart(4, '0'),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function parkMinuteOfDay(date = new Date()): number {
  const { hour, minute } = parkDateTimeParts(date);
  return hour * 60 + minute;
}
