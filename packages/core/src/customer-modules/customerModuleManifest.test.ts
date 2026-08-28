import { describe, expect, it } from 'vitest';

import {
  parseCustomerModuleManifest,
  validateCustomerModuleArchiveEntries,
  type CustomerModuleManifestV1,
} from './customerModuleManifest.js';

function manifest(overrides: Partial<CustomerModuleManifestV1> = {}): CustomerModuleManifestV1 {
  return {
    schemaVersion: 1,
    id: 'com.acme.monthly-report',
    name: '月报生成器',
    version: '1.0.0',
    publisher: { id: 'acme', name: 'Acme' },
    description: '生成月度报告',
    icon: 'icon.svg',
    entrypoint: 'module.wasm',
    hostApi: 'otto.customer-module.v1',
    minimumOttoVersion: '1.15.3',
    inputSchema: { type: 'object', properties: {} },
    outputs: ['text'],
    permissions: [],
    files: {
      'module.wasm': 'a'.repeat(64),
      'icon.svg': 'b'.repeat(64),
    },
    signature: { algorithm: 'ed25519', keyId: 'market-v1', value: 'ed25519:signature' },
    ...overrides,
  };
}

describe('customer module manifest', () => {
  it('accepts a minimal signed WASM module', () => {
    expect(parseCustomerModuleManifest(manifest())).toEqual(manifest());
  });

  it('allows unsigned authoring drafts but never installable manifests', () => {
    const draft = manifest();
    delete draft.signature;
    expect(parseCustomerModuleManifest(draft, { requireSignature: false })).toEqual(draft);
    expect(() => parseCustomerModuleManifest(draft)).toThrow(/signature/);
  });

  it.each([
    ['JS entrypoint', { entrypoint: 'index.js' }],
    ['unsafe id', { id: '../escape' }],
    ['unknown host ABI', { hostApi: 'otto.customer-module.v2' }],
    ['background by default', { permissions: [{ kind: 'background', defaultEnabled: true }] }],
    ['wildcard HTTP', { permissions: [{ kind: 'http', hosts: ['*'] }] }],
    ['duplicate permissions', { permissions: [{ kind: 'model', paid: true }, { kind: 'model', paid: false }] }],
    ['implicit model cost', { permissions: [{ kind: 'model' }] }],
    ['arbitrary file access', { permissions: [{ kind: 'file', access: 'filesystem' }] }],
    ['unknown required field', { inputSchema: { type: 'object', properties: {}, required: ['missing'] } }],
    ['executable form field', { inputSchema: { type: 'object', properties: { code: { type: 'html' } } } }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => parseCustomerModuleManifest(manifest(overrides as Partial<CustomerModuleManifestV1>)))
      .toThrow();
  });

  it('rejects archive traversal, symlinks, undeclared and duplicate files', () => {
    expect(() => validateCustomerModuleArchiveEntries(manifest(), [
      { path: 'module.wasm', kind: 'file', size: 12 },
      { path: '../secret', kind: 'file', size: 4 },
    ])).toThrow(/unsafe path/);
    expect(() => validateCustomerModuleArchiveEntries(manifest(), [
      { path: 'module.wasm', kind: 'symlink', size: 12 },
    ])).toThrow(/symlink/);
    expect(() => validateCustomerModuleArchiveEntries(manifest(), [
      { path: 'module.wasm', kind: 'file', size: 12 },
      { path: 'extra.txt', kind: 'file', size: 4 },
    ])).toThrow(/undeclared/);
    expect(() => validateCustomerModuleArchiveEntries(manifest(), [
      { path: 'module.wasm', kind: 'file', size: 12 },
      { path: 'module.wasm', kind: 'file', size: 12 },
    ])).toThrow(/duplicate/);
  });
});
