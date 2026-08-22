/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { commercialBillingOperationForRoute } from './commercialBillingRoutePolicy.js';

describe('commercial billing route policy', () => {
  it.each([
    ['/enterprise/park/services/request', 'park_service'],
    ['/enterprise/knowledge', 'enterprise_knowledge'],
    ['/enterprise/skills', 'skill_market'],
  ] as const)('charges an exact POST mutation at %s', (path, module) => {
    expect(commercialBillingOperationForRoute(path, 'POST')).toEqual({
      module,
      units: 1,
    });
    expect(commercialBillingOperationForRoute(path, 'GET')).toBeNull();
  });

  it('charges park tickets only after record-level service classification', () => {
    expect(commercialBillingOperationForRoute(
      '/enterprise/tickets',
      'POST',
      { ticketServiceId: 'repair' },
    )).toEqual({ module: 'park_service', units: 1 });
    expect(commercialBillingOperationForRoute(
      '/enterprise/tickets',
      'POST',
      { ticketServiceId: 'it' },
    )).toBeNull();
    expect(commercialBillingOperationForRoute('/enterprise/tickets', 'POST')).toBeNull();
  });

  it('does not charge similarly prefixed or maintenance routes', () => {
    expect(commercialBillingOperationForRoute('/enterprise/knowledge/1', 'POST'))
      .toBeNull();
    expect(commercialBillingOperationForRoute('/enterprise/skills/leaderboard', 'POST'))
      .toBeNull();
    expect(commercialBillingOperationForRoute('/enterprise/deployment/status', 'POST'))
      .toBeNull();
  });
});
