/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type {
  Database,
  EncryptedFieldCipher,
  EncryptedObjectStore,
} from '../data_platform/index.js';
import {
  deleteOwnAccountDataInRepository,
  exportAccountDataFromRepository,
  getDataGovernanceProfileFromRepository,
  reapplyPrivacyDeletionTombstones,
  recordCurrentLegalConsentInRepository,
  type DataGovernanceAccount,
} from './dataGovernanceRepository.js';
import type { LegalDocumentReference } from './legalDocuments.js';
import { createPrivacyDeletionLedger } from './privacyDeletionLedger.js';

export function createDataGovernanceComposition(input: {
  db(): Database;
  ledgerPath: string;
  ledgerKeyPath: string;
  fieldCipher?: EncryptedFieldCipher;
  attachmentObjectStore?: EncryptedObjectStore;
  createDeletionPasswordHash(secret: string): string;
  now?(): number;
}) {
  const ledger = createPrivacyDeletionLedger({
    ledgerPath: input.ledgerPath,
    keyPath: input.ledgerKeyPath,
  });
  const store = {
    db: input.db,
    now: input.now ?? Date.now,
    createId: randomUUID,
    createDeletionPasswordHash: () => input.createDeletionPasswordHash(randomBytes(32).toString('base64url')),
    fieldCipher: input.fieldCipher,
    attachmentObjectStore: input.attachmentObjectStore,
    appendDeletionTombstone: ledger.append,
  };
  return {
    getDataGovernanceProfile: (account?: DataGovernanceAccount | null) => getDataGovernanceProfileFromRepository(store, account),
    recordCurrentLegalConsent: (
      account: DataGovernanceAccount,
      source: 'registration' | 'settings' | 'migration',
      references: readonly LegalDocumentReference[],
    ) => recordCurrentLegalConsentInRepository(store, account, source, references),
    exportAccountData: (account: DataGovernanceAccount) => exportAccountDataFromRepository(store, account),
    deleteOwnAccountData: (account: DataGovernanceAccount) => deleteOwnAccountDataInRepository(store, account),
    reapplyPrivacyDeletionTombstones: () => reapplyPrivacyDeletionTombstones(store, ledger.list()),
  };
}
