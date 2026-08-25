/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/** Calendar date in the user's local timezone. */
export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
