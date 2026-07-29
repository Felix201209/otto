/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { createEnterpriseKnowledgeFacade } from './knowledgeFacade.js';

export interface EnterpriseKnowledgeCompositionOrganization {
  id: string;
}

export interface EnterpriseKnowledgeCompositionOptions<
  TOrganization extends EnterpriseKnowledgeCompositionOrganization,
> {
  db(): Database;
  defaultOrganizationId: string;
  getOrganization(organizationId: string): TOrganization | null;
}

/** Builds tenant-scoped knowledge access around the organization directory. */
export function createEnterpriseKnowledgeComposition<
  TOrganization extends EnterpriseKnowledgeCompositionOrganization,
>(options: EnterpriseKnowledgeCompositionOptions<TOrganization>) {
  return createEnterpriseKnowledgeFacade({
    db: options.db,
    defaultOrganizationId: options.defaultOrganizationId,
    organizationExists: (organizationId) =>
      options.getOrganization(organizationId) !== null,
  });
}
