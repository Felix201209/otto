/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export const ACCOUNT_SYNC_SCOPES = [
  'personal_memory',
  'worklog',
  'auto_skills',
] as const;

export type AccountSyncScope = (typeof ACCOUNT_SYNC_SCOPES)[number];

export interface AccountSyncFile {
  path: string;
  content: string;
  modifiedAtMs: number;
  sha256: string;
}

export interface AccountSyncPayload {
  schemaVersion: 1;
  generatedAt: string;
  files: AccountSyncFile[];
  truncated?: boolean;
}

export interface AccountSyncSnapshotView {
  scope: AccountSyncScope;
  version: number;
  payload: AccountSyncPayload;
  payloadHash: string;
  deviceId: string | null;
  updatedAtMs: number;
}

export interface AccountSyncIdentity {
  accountId: string;
  organizationId: string;
}

export interface PutAccountSyncSnapshotInput {
  accountId: string;
  scope: AccountSyncScope;
  expectedVersion: number;
  payload: unknown;
  deviceId?: string | null;
}

export class AccountSyncConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('account sync snapshot changed on another device');
    this.name = 'AccountSyncConflictError';
  }
}
