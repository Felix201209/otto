/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { OrganizationFeatureKey } from '../../productModules.js';
import type { Database } from '../data_platform/index.js';
import { createOrganizationFeatureFacade } from '../identity_organization/index.js';
import { createOrganizationFeatureAccessFacade } from './organizationFeatureAccess.js';

export interface AuthorizationCompositionOptions {
  db(): Database;
  audit(
    event: string,
    employeeId: string | null,
    detail: string,
    organizationId: string,
  ): void;
  isLicenseUsable(feature: OrganizationFeatureKey): boolean;
}

/** Combines configured switches and licensed capabilities fail-closed. */
export function createAuthorizationComposition(
  options: AuthorizationCompositionOptions,
) {
  const configuration = createOrganizationFeatureFacade({
    db: options.db,
    audit: options.audit,
  });
  return createOrganizationFeatureAccessFacade({
    configuration,
    isLicenseUsable: options.isLicenseUsable,
  });
}
