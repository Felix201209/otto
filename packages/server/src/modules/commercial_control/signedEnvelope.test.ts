/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  parsePublicKeyList,
  publicKeyId,
  signEd25519Envelope,
  verifyEd25519Envelope,
} from './signedEnvelope.js';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
    publicKey: pair.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString(),
  };
}

describe('Ed25519 signed envelopes', () => {
  it('signs canonical JSON and supports public-key rotation', () => {
    const oldKey = keys();
    const currentKey = keys();
    const payload = { z: 1, nested: { b: true, a: 'stable' }, a: 2 };
    const reordered = { a: 2, nested: { a: 'stable', b: true }, z: 1 };
    const signature = signEd25519Envelope(payload, currentKey.privateKey);

    expect(canonicalJson(payload)).toBe(canonicalJson(reordered));
    expect(
      verifyEd25519Envelope(reordered, signature, [
        oldKey.publicKey,
        currentKey.publicKey,
      ]),
    ).toEqual({ valid: true, keyId: publicKeyId(currentKey.publicKey) });
  });

  it('rejects tampering, legacy HMAC strings, and malformed keys', () => {
    const key = keys();
    const signature = signEd25519Envelope({ seats: 20 }, key.privateKey);
    expect(
      verifyEd25519Envelope({ seats: 21 }, signature, [key.publicKey]).valid,
    ).toBe(false);
    expect(
      verifyEd25519Envelope({ seats: 20 }, 'legacy-hmac', [key.publicKey]).valid,
    ).toBe(false);
    expect(
      verifyEd25519Envelope({ seats: 20 }, signature, ['not-a-key']).valid,
    ).toBe(false);
  });

  it('loads either one PEM key or a JSON rotation list', () => {
    const first = keys().publicKey;
    const second = keys().publicKey;
    expect(parsePublicKeyList(first)).toEqual([first.trim()]);
    expect(parsePublicKeyList(JSON.stringify([first, second]))).toEqual([
      first,
      second,
    ]);
    expect(parsePublicKeyList('[broken')).toEqual([]);
  });
});
