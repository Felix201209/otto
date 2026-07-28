/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { Database } from '../data_platform/index.js';
import { resolveAssignmentIdentityInRepository } from './assignmentIdentityRepository.js';
import type {
  AssignmentIdentity,
  AssignmentIdentityInput,
} from './assignmentIdentityTypes.js';

export interface AssignmentIdentityFacade {
  resolveAssignmentIdentity(
    database: Database,
    organizationId: string,
    input: AssignmentIdentityInput,
  ): AssignmentIdentity;
}

export function createAssignmentIdentityFacade(): AssignmentIdentityFacade {
  return {
    resolveAssignmentIdentity(database, organizationId, input) {
      return resolveAssignmentIdentityInRepository(
        database,
        organizationId,
        input,
      );
    },
  };
}
