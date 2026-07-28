/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { EncryptionKeyProvider } from '../data_platform/index.js';
import { normalizeAccountSyncPayload } from './accountSyncValidation.js';
import type {
  AccountSyncPayload,
  AccountSyncScope,
} from './accountSyncTypes.js';

const ACCOUNT_SYNC_MAX_DECRYPTED_BYTES = 16 * 1024 * 1024;
const ACCOUNT_SYNC_INTEGRITY_ERROR =
  'account sync snapshot integrity check failed';

export type AccountSyncEncryptionKeyProvider = EncryptionKeyProvider;

export interface AccountSyncEncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  payloadHash: string;
}

export interface AccountSyncEncryptedRow {
  account_id: string;
  organization_id: string;
  scope: AccountSyncScope;
  version: number;
  payload_ciphertext: string;
  payload_iv: string;
  payload_auth_tag: string;
  payload_hash: string;
}

function accountSyncAad(input: {
  account_id: string;
  organization_id: string;
  scope: AccountSyncScope;
  version: number;
}): Buffer {
  return Buffer.from(
    [
      input.account_id,
      input.organization_id,
      input.scope,
      String(input.version),
    ].join('\0'),
    'utf8',
  );
}

function hashesMatch(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch {
    return false;
  }
}

export function encryptAccountSyncPayload(
  keyProvider: AccountSyncEncryptionKeyProvider,
  input: {
    accountId: string;
    organizationId: string;
    scope: AccountSyncScope;
    version: number;
    payload: AccountSyncPayload;
  },
): AccountSyncEncryptedPayload {
  const raw = JSON.stringify(input.payload);
  const payloadHash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyProvider.getKey(), iv);
  cipher.setAAD(
    accountSyncAad({
      account_id: input.accountId,
      organization_id: input.organizationId,
      scope: input.scope,
      version: input.version,
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(gzipSync(Buffer.from(raw, 'utf8'))),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    payloadHash,
  };
}

export function decryptAccountSyncPayload(
  keyProvider: AccountSyncEncryptionKeyProvider,
  row: AccountSyncEncryptedRow,
): AccountSyncPayload {
  try {
    const iv = Buffer.from(row.payload_iv, 'base64');
    const authTag = Buffer.from(row.payload_auth_tag, 'base64');
    if (iv.length !== 12 || authTag.length !== 16) {
      throw new Error(ACCOUNT_SYNC_INTEGRITY_ERROR);
    }
    const decipher = createDecipheriv('aes-256-gcm', keyProvider.getKey(), iv);
    decipher.setAAD(accountSyncAad(row));
    decipher.setAuthTag(authTag);
    const compressed = Buffer.concat([
      decipher.update(Buffer.from(row.payload_ciphertext, 'base64')),
      decipher.final(),
    ]);
    const raw = gunzipSync(compressed, {
      maxOutputLength: ACCOUNT_SYNC_MAX_DECRYPTED_BYTES,
    }).toString('utf8');
    const payloadHash = createHash('sha256').update(raw, 'utf8').digest('hex');
    if (!hashesMatch(payloadHash, row.payload_hash)) {
      throw new Error(ACCOUNT_SYNC_INTEGRITY_ERROR);
    }
    return normalizeAccountSyncPayload(row.scope, JSON.parse(raw) as unknown);
  } catch {
    throw new Error(ACCOUNT_SYNC_INTEGRITY_ERROR);
  }
}
