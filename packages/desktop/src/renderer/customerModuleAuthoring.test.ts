import { describe, expect, it } from 'vitest';
import { buildCustomerModuleSubmission, locallyValidateCustomerModuleWasm } from './customerModuleAuthoring.js';

const WASM = Uint8Array.from([
  0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0,
  7,12,1,8,111,116,116,111,95,114,117,110,0,0, 10,6,1,4,0,65,0,11,
]);

describe('customer module authoring', () => {
  it('builds a deterministic unsigned package for server-side review signing', async () => {
    const result = await buildCustomerModuleSubmission({
      draft: {
        id: 'com.acme.report', name: '月报', version: '1.0.0', description: '生成月报',
        releaseNotes: '首次发布',
        minimumOttoVersion: '1.15.3', permissions: [], inputSchema: { type: 'object', properties: {} },
      },
      publisher: { id: 'account-1', name: 'King' }, wasm: WASM,
    });
    expect(result.manifest).toMatchObject({ id: 'com.acme.report', entrypoint: 'module.wasm' });
    expect(result.manifest).not.toHaveProperty('signature');
    expect((result.manifest.files as Record<string, string>)['module.wasm']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('performs local WASM validation before upload', async () => {
    await expect(locallyValidateCustomerModuleWasm(WASM)).resolves.toEqual([]);
    await expect(locallyValidateCustomerModuleWasm(Uint8Array.from([0,97,115,109,1,0,0,0])))
      .rejects.toThrow(/otto_run/);
  });
});
