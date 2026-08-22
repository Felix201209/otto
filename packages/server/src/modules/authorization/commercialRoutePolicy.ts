/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { OrganizationFeatureKey } from '../../productModules.js';

interface CommercialRouteRule {
  feature: OrganizationFeatureKey;
  matches(path: string): boolean;
}

export interface CommercialRouteContext {
  ticketServiceId?: string;
}

const prefix = (value: string) => (path: string): boolean =>
  path === value || path.startsWith(`${value}/`);

/**
 * Maps externally callable enterprise routes to the signed License capability
 * required before the request reaches a business handler.
 *
 * Authentication, License maintenance, diagnostics, backup and privacy export
 * routes are deliberately absent so an expired customer can recover access and
 * export its data.
 */
const COMMERCIAL_ROUTE_RULES: readonly CommercialRouteRule[] = [
  {
    feature: 'model_gateway',
    matches: prefix('/enterprise/model-gateway'),
  },
  { feature: 'atoa', matches: prefix('/enterprise/federation/a2a') },
  { feature: 'direct_messages', matches: prefix('/enterprise/federation') },
  { feature: 'atoa', matches: prefix('/enterprise/atoa') },
  { feature: 'direct_messages', matches: prefix('/enterprise/messages') },
  { feature: 'direct_messages', matches: prefix('/enterprise/message-attachments') },
  { feature: 'direct_messages', matches: prefix('/enterprise/attachments') },
  { feature: 'direct_messages', matches: prefix('/enterprise/e2ee') },
  { feature: 'direct_messages', matches: prefix('/enterprise/presence/heartbeat') },
  { feature: 'park_service', matches: prefix('/enterprise/park') },
  { feature: 'park_service', matches: (path) => path.startsWith('/enterprise/park-') },
  { feature: 'park_service', matches: prefix('/enterprise/park-services') },
  { feature: 'park_service', matches: prefix('/enterprise/park-resources') },
  { feature: 'park_service', matches: prefix('/enterprise/park-statistics') },
  { feature: 'skill_market', matches: prefix('/enterprise/skills') },
  { feature: 'knowledge', matches: prefix('/enterprise/knowledge') },
  { feature: 'enterprise_tree', matches: prefix('/enterprise/organization') },
  { feature: 'enterprise_tree', matches: prefix('/enterprise/organizations') },
  { feature: 'enterprise_tree', matches: prefix('/enterprise/accounts') },
  { feature: 'enterprise_tree', matches: prefix('/enterprise/platform/organizations') },
] as const;

export function commercialFeatureForEnterpriseRoute(
  path: string,
  context: CommercialRouteContext = {},
): OrganizationFeatureKey | null {
  if (path === '/enterprise/tickets') {
    return context.ticketServiceId && context.ticketServiceId !== 'it'
      ? 'park_service'
      : null;
  }
  return COMMERCIAL_ROUTE_RULES.find((rule) => rule.matches(path))?.feature ?? null;
}
