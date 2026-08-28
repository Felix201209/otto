import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CustomerModuleManifestV1 } from './customerModuleManifest.js';
import { canonicalCustomerModuleManifest, verifyCustomerModuleSignature } from './customerModuleSignature.js';

describe('customer module signatures', () => {
  it('verifies the canonical unsigned manifest and rejects tampering or unknown keys', () => {
    const keys = generateKeyPairSync('ed25519');
    const manifest = {
      schemaVersion: 1, id: 'com.acme.signed', name: 'Signed', version: '1.0.0',
      publisher: { id: 'acme', name: 'Acme' }, description: 'Signed module',
      icon: 'icon.svg', entrypoint: 'module.wasm', hostApi: 'otto.customer-module.v1',
      minimumOttoVersion: '1.15.3', inputSchema: { type: 'object', properties: {} },
      outputs: ['text'], permissions: [], files: { 'module.wasm': 'a'.repeat(64), 'icon.svg': 'b'.repeat(64) },
    } satisfies Omit<CustomerModuleManifestV1, 'signature'>;
    const signature = sign(null, Buffer.from(canonicalCustomerModuleManifest(manifest)), keys.privateKey).toString('base64url');
    const signed: CustomerModuleManifestV1 = { ...manifest, signature: { algorithm: 'ed25519', keyId: 'market-v1', value: `ed25519:${signature}` } };
    expect(verifyCustomerModuleSignature(signed, { 'market-v1': keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() })).toBe(true);
    expect(verifyCustomerModuleSignature({ ...signed, name: 'Tampered' }, { 'market-v1': keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() })).toBe(false);
    expect(verifyCustomerModuleSignature(signed, {})).toBe(false);
  });
});
