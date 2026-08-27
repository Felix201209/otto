/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

import type {
  Database,
  EncryptedFieldCipher,
  EncryptedObjectStore,
} from '../data_platform/index.js';
import {
  approveEnterpriseVerificationApplication as approveInRepository,
  cancelEnterpriseVerificationApplication as cancelInRepository,
  getEnterpriseVerificationApplicationForApplicant as getForApplicantInRepository,
  listEnterpriseVerificationApplications as listInRepository,
  readEnterpriseVerificationEvidence as readEvidenceInRepository,
  rejectEnterpriseVerificationApplication as rejectInRepository,
  submitEnterpriseVerificationApplication as submitInRepository,
  uploadEnterpriseVerificationEvidence as uploadEvidenceInRepository,
  type EnterpriseVerificationRepositoryStore,
} from './enterpriseVerificationRepository.js';
import type {
  ApproveEnterpriseVerificationApplicationInput,
  CancelEnterpriseVerificationApplicationInput,
  GetEnterpriseVerificationApplicationForApplicantInput,
  ListEnterpriseVerificationApplicationsInput,
  ReadEnterpriseVerificationEvidenceInput,
  RejectEnterpriseVerificationApplicationInput,
  SubmitEnterpriseVerificationApplicationInput,
  UploadEnterpriseVerificationEvidenceInput,
} from './enterpriseVerificationTypes.js';

export interface EnterpriseVerificationCompositionDependencies {
  db(): Database;
  fieldCipher: EncryptedFieldCipher;
  objectStore: EncryptedObjectStore;
  isPlatformReviewer(reviewerId: string): boolean;
  now?(): number;
  createApplicationId?(): string;
  createDepartmentId?(): string;
  createEmployeeId?(): string;
  createEvidenceId?(): string;
}

export function createEnterpriseVerificationComposition(
  dependencies: EnterpriseVerificationCompositionDependencies,
) {
  const store: EnterpriseVerificationRepositoryStore = {
    db: dependencies.db,
    fieldCipher: dependencies.fieldCipher,
    objectStore: dependencies.objectStore,
    isPlatformReviewer: dependencies.isPlatformReviewer,
    now: dependencies.now ?? Date.now,
    createApplicationId:
      dependencies.createApplicationId ?? (() => `ev_${randomUUID()}`),
    createDepartmentId:
      dependencies.createDepartmentId ?? (() => `dept_${randomUUID()}`),
    createEmployeeId:
      dependencies.createEmployeeId ?? (() => `emp_${randomUUID()}`),
    createEvidenceId:
      dependencies.createEvidenceId ?? (() => `eve_${randomUUID()}`),
  };

  return {
    submitEnterpriseVerificationApplication: (
      input: SubmitEnterpriseVerificationApplicationInput,
    ) => submitInRepository(store, input),
    getEnterpriseVerificationApplicationForApplicant: (
      input: GetEnterpriseVerificationApplicationForApplicantInput,
    ) => getForApplicantInRepository(store, input),
    listEnterpriseVerificationApplications: (
      input: ListEnterpriseVerificationApplicationsInput,
    ) => listInRepository(store, input),
    cancelEnterpriseVerificationApplication: (
      input: CancelEnterpriseVerificationApplicationInput,
    ) => cancelInRepository(store, input),
    approveEnterpriseVerificationApplication: (
      input: ApproveEnterpriseVerificationApplicationInput,
    ) => approveInRepository(store, input),
    rejectEnterpriseVerificationApplication: (
      input: RejectEnterpriseVerificationApplicationInput,
    ) => rejectInRepository(store, input),
    uploadEnterpriseVerificationEvidence: (
      input: UploadEnterpriseVerificationEvidenceInput,
    ) => uploadEvidenceInRepository(store, input),
    readEnterpriseVerificationEvidence: (
      input: ReadEnterpriseVerificationEvidenceInput,
    ) => readEvidenceInRepository(store, input),
  };
}

export type EnterpriseVerificationComposition = ReturnType<
  typeof createEnterpriseVerificationComposition
>;
