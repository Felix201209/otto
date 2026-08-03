/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { commercialFeatureForEnterpriseRoute } from './commercialRoutePolicy.js';

describe('commercial enterprise route policy', () => {
  it.each([
    ['/enterprise/atoa/inbox', 'atoa'],
    ['/enterprise/messages/unread', 'direct_messages'],
    ['/enterprise/message-attachments/file-1', 'direct_messages'],
    ['/enterprise/park/services/request', 'park_service'],
    ['/enterprise/park-statistics/inbox', 'park_service'],
    ['/enterprise/skills/leaderboard', 'skill_market'],
    ['/enterprise/knowledge/revisions', 'knowledge'],
    ['/enterprise/organization/departments', 'enterprise_tree'],
    ['/enterprise/platform/organizations/org-a', 'enterprise_tree'],
  ] as const)('maps %s to %s', (path, feature) => {
    expect(commercialFeatureForEnterpriseRoute(path)).toBe(feature);
  });

  it.each([
    '/enterprise/auth/login',
    '/enterprise/deployment/license',
    '/enterprise/deployment/license/lease',
    '/enterprise/deployment/diagnostics',
    '/enterprise/deployment/data-protection/backup',
    '/enterprise/export',
    '/enterprise/privacy/export',
    '/enterprise/modules/updates',
  ])('keeps recovery route %s outside module gates', (path) => {
    expect(commercialFeatureForEnterpriseRoute(path)).toBeNull();
  });

  it('leaves the mixed enterprise and park ticket route to ticket-level policy', () => {
    expect(commercialFeatureForEnterpriseRoute('/enterprise/tickets')).toBeNull();
    expect(commercialFeatureForEnterpriseRoute('/enterprise/tickets/ticket-1/action')).toBeNull();
  });

  it('does not match similar unowned path prefixes', () => {
    expect(commercialFeatureForEnterpriseRoute('/enterprise/parking-lot')).toBeNull();
    expect(commercialFeatureForEnterpriseRoute('/enterprise/messaging')).toBeNull();
  });
});
