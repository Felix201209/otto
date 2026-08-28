import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { CustomerModuleMarketplace } from './customerModuleMarketplace.js';
import { InMemoryCustomerModuleMarketplaceStore } from './customerModuleRepository.js';
import { submitCustomerModulePackage } from './customerModuleSubmission.js';

const WASM = Uint8Array.from([
  0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0,
  7,12,1,8,111,116,116,111,95,114,117,110,0,0, 10,6,1,4,0,65,0,11,
]);
const ICON = new TextEncoder().encode('<svg/>');
const LOOP_WASM = Uint8Array.from([
  0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0,
  7,12,1,8,111,116,116,111,95,114,117,110,0,0, 10,11,1,9,0,3,64,12,0,11,65,0,11,
]);
const hash = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

function draft() {
  return {
    schemaVersion: 1, id: 'com.acme.upload', name: 'Upload', version: '1.0.0',
    publisher: { id: 'publisher', name: 'Publisher' }, description: 'Uploaded module',
    icon: 'icon.svg', entrypoint: 'module.wasm', hostApi: 'otto.customer-module.v1',
    minimumOttoVersion: '1.15.3', inputSchema: { type: 'object', properties: {} },
    outputs: ['text'], permissions: [],
    files: { 'module.wasm': hash(WASM), 'icon.svg': hash(ICON) },
  };
}

describe('customer module package submission', () => {
  it('scans before persisting artifacts and advances to human review', async () => {
    const store = new InMemoryCustomerModuleMarketplaceStore();
    const market = new CustomerModuleMarketplace(undefined, store);
    const result = await submitCustomerModulePackage({
      publisherId: 'publisher', manifest: draft(),
      files: new Map([['module.wasm', WASM], ['icon.svg', ICON]]), market, store,
    });
    expect(result.status).toBe('review');
    expect(store.getArtifacts('com.acme.upload', '1.0.0').get('module.wasm')).toEqual(WASM);
  });

  it('records a failed scan and never persists invalid artifacts', async () => {
    const store = new InMemoryCustomerModuleMarketplaceStore();
    const market = new CustomerModuleMarketplace(undefined, store);
    const invalid = Uint8Array.from([0,97,115,109,1,0,0,0]);
    const manifest = draft(); manifest.files['module.wasm'] = hash(invalid);
    await expect(submitCustomerModulePackage({
      publisherId: 'publisher', manifest,
      files: new Map([['module.wasm', invalid], ['icon.svg', ICON]]), market, store,
    })).rejects.toThrow(/otto_run/);
    expect(store.getArtifacts('com.acme.upload', '1.0.0').size).toBe(0);
    expect(market.get('com.acme.upload', '1.0.0')?.scanReport?.passed).toBe(false);
  });

  it('rejects a statically valid module that never yields in the sandbox', async () => {
    const store = new InMemoryCustomerModuleMarketplaceStore();
    const market = new CustomerModuleMarketplace(undefined, store);
    const manifest = draft(); manifest.files['module.wasm'] = hash(LOOP_WASM);
    await expect(submitCustomerModulePackage({
      publisherId: 'publisher', manifest,
      files: new Map([['module.wasm', LOOP_WASM], ['icon.svg', ICON]]), market, store,
    })).rejects.toThrow(/sandbox negative test/);
    expect(store.getArtifacts('com.acme.upload', '1.0.0').size).toBe(0);
  });
});
