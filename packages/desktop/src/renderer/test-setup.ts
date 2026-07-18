/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  const existing = window.otto ?? {};
  Object.defineProperty(window, 'otto', {
    configurable: true,
    writable: true,
    value: {
      ...existing,
      send: vi.fn(),
    } as unknown as Window['otto'],
  });
});
