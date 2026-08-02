/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { DeploymentBillingModule } from './billingUsageRepository.js';

export interface CommercialBillingRouteOperation {
  module: DeploymentBillingModule;
  units: number;
}

/** Fixed-unit server operations that must reserve credits before mutation. */
export function commercialBillingOperationForRoute(
  path: string,
  method: string,
): CommercialBillingRouteOperation | null {
  if (method !== 'POST') return null;
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
