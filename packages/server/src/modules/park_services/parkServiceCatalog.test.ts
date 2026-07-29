/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARK_SERVICES,
  isParkRequestServiceId,
  isParkServiceId,
  PARK_REQUEST_SERVICE_DEFINITIONS,
  PARK_SERVICE_CATALOG,
} from './parkServiceCatalog.js';

describe('park service catalog', () => {
  it('keeps one unique catalog with nine services and seven request types', () => {
    const serviceIds = PARK_SERVICE_CATALOG.map(({ id }) => id);
    expect(new Set(serviceIds).size).toBe(serviceIds.length);
    expect(DEFAULT_PARK_SERVICES).toHaveLength(9);
    expect(PARK_REQUEST_SERVICE_DEFINITIONS).toHaveLength(7);
    expect(PARK_REQUEST_SERVICE_DEFINITIONS.map(([id]) => id)).toEqual([
      'renovation',
      'parking',
      'network-phone',
      'meeting-room',
      'electric-card',
      'repair',
      'vehicle-visit',
    ]);
  });

  it('does not allow publication-only services to create tickets', () => {
    expect(isParkServiceId('announcement')).toBe(true);
    expect(isParkServiceId('satisfaction')).toBe(true);
    expect(isParkRequestServiceId('repair')).toBe(true);
    expect(isParkRequestServiceId('announcement')).toBe(false);
    expect(isParkRequestServiceId('satisfaction')).toBe(false);
    expect(isParkServiceId('unknown')).toBe(false);
  });
});
