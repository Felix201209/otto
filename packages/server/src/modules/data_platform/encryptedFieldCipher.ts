/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

import type { EncryptionKeyProvider } from './fileEncryptionKeyProvider.js';

const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export interface EncryptedFieldValue {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

export interface EncryptedFieldCipher {
  encryptText(value: string, context: string): EncryptedFieldValue;
  decryptText(value: EncryptedFieldValue, context: string): string;
}

function decodeCanonicalBase64(value: string, label: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label} is not canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return decoded;
}

/** Encrypts searchable-database payload fields while leaving indexes separate. */
export function createEncryptedFieldCipher(input: {
  keyProvider: EncryptionKeyProvider;
}): EncryptedFieldCipher {
  return {
    encryptText(value, context) {
      if (!context) throw new Error('encrypted field context is required');
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', input.keyProvider.getKey(), iv, {
        authTagLength: AUTH_TAG_BYTES,
      });
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ]);
      return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
        keyVersion: 1,
      };
    },
    decryptText(value, context) {
      if (!context) throw new Error('encrypted field context is required');
      if (value.keyVersion !== 1) {
        throw new Error('encrypted field key version is unsupported');
      }
      const iv = decodeCanonicalBase64(value.iv, 'encrypted field IV');
      const authTag = decodeCanonicalBase64(
        value.authTag,
        'encrypted field authentication tag',
      );
      if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        throw new Error('encrypted field metadata has an invalid length');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        input.keyProvider.getKey(),
        iv,
        { authTagLength: AUTH_TAG_BYTES },
      );
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(
          decodeCanonicalBase64(value.ciphertext, 'encrypted field ciphertext'),
        ),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
