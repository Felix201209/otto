/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { createEncryptedFieldCipher } from './encryptedFieldCipher.js';

describe('encrypted field cipher', () => {
  it('round-trips UTF-8 text and binds ciphertext to its context', () => {
    const key = Buffer.alloc(32, 7);
    const cipher = createEncryptedFieldCipher({
      keyProvider: { getKey: () => key, clear() {} },
    });
    const encrypted = cipher.encryptText('企业私聊正文', 'message:org-a:msg-a');

    expect(encrypted.ciphertext).not.toContain('企业私聊正文');
    expect(cipher.decryptText(encrypted, 'message:org-a:msg-a')).toBe(
      '企业私聊正文',
    );
    expect(() => cipher.decryptText(encrypted, 'message:org-b:msg-a')).toThrow();
  });

  it('rejects modified authentication metadata', () => {
    const key = Buffer.alloc(32, 9);
    const cipher = createEncryptedFieldCipher({
      keyProvider: { getKey: () => key, clear() {} },
    });
    const encrypted = cipher.encryptText('secret', 'message:org-a:msg-a');

    expect(() => cipher.decryptText({
      ...encrypted,
      authTag: Buffer.alloc(16, 1).toString('base64'),
    }, 'message:org-a:msg-a')).toThrow();
  });
});
