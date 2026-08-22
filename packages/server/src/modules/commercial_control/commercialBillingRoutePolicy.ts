/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DeploymentBillingModule } from './billingUsageRepository.js';

export interface CommercialBillingRouteOperation {
  module: DeploymentBillingModule;
  units: number;
}

export interface CommercialBillingRouteContext {
  ticketServiceId?: string;
}

/** Fixed-unit server operations that must reserve credits before mutation. */
export function commercialBillingOperationForRoute(
  path: string,
  method: string,
  context: CommercialBillingRouteContext = {},
): CommercialBillingRouteOperation | null {
  if (method !== 'POST') return null;
  if (
    path === '/enterprise/tickets'
    && context.ticketServiceId
    && context.ticketServiceId !== 'it'
  ) {
    return { module: 'park_service', units: 1 };
  }
  if (path === '/enterprise/park/services/request') {
    return { module: 'park_service', units: 1 };
  }
  if (path === '/enterprise/knowledge') {
    return { module: 'enterprise_knowledge', units: 1 };
  }
  if (path === '/enterprise/skills') {
    return { module: 'skill_market', units: 1 };
  }
  return null;
}
