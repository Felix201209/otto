import { describe, expect, it } from 'vitest';

import { scanCustomerModuleWasm, verifyCustomerModuleFileHashes } from './customerModuleScanner.js';

const EMPTY_WASM = Uint8Array.from([
  0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0,
  7,12,1,8,111,116,116,111,95,114,117,110,0,0, 10,6,1,4,0,65,0,11,
]);
function wasiImport(name: string): Uint8Array {
  const encoder = new TextEncoder();
  const moduleName = encoder.encode('wasi_snapshot_preview1');
  const importName = encoder.encode(name);
  const payload = [1, moduleName.length, ...moduleName, importName.length, ...importName, 0, 0];
  return Uint8Array.from([
    0,97,115,109,1,0,0,0, 1,11,2,96,2,127,127,1,127,96,0,1,127,
    2,payload.length,...payload, 3,2,1,1, 5,4,1,1,1,16,
    7,21,2,6,109,101,109,111,114,121,2,0,8,111,116,116,111,95,114,117,110,0,1,
    10,6,1,4,0,65,0,11,
  ]);
}

describe('customer module scanner', () => {
  it('accepts a valid module with no ambient imports', async () => {
    await expect(scanCustomerModuleWasm(EMPTY_WASM)).resolves.toEqual({ imports: [], exports: ['otto_run'] });
  });

  it('rejects malformed binaries and files whose digest differs', async () => {
    await expect(scanCustomerModuleWasm(Uint8Array.from([1, 2, 3]))).rejects.toThrow(/WASM/);
    await expect(scanCustomerModuleWasm(Uint8Array.from([0,97,115,109,1,0,0,0])))
      .rejects.toThrow(/otto_run/);
    await expect(verifyCustomerModuleFileHashes(
      { 'module.wasm': '0'.repeat(64) },
      new Map([['module.wasm', EMPTY_WASM]]),
    )).rejects.toThrow(/hash mismatch/);
  });

  it('rejects undeclared and missing file bodies', async () => {
    await expect(verifyCustomerModuleFileHashes(
      { 'module.wasm': '0'.repeat(64) },
      new Map([['extra.bin', EMPTY_WASM]]),
    )).rejects.toThrow(/undeclared/);
  });

  it('requires an explicit 64 MiB-or-lower maximum for linear memory', async () => {
    const unboundedMemory = Uint8Array.from([
      0,97,115,109,1,0,0,0, 1,5,1,96,0,1,127, 3,2,1,0,
      5,3,1,0,1, 7,12,1,8,111,116,116,111,95,114,117,110,0,0,
      10,6,1,4,0,65,0,11,
    ]);
    await expect(scanCustomerModuleWasm(unboundedMemory)).rejects.toThrow(/declare a maximum/);
  });

  it('allows only the non-network, non-filesystem WASI preview1 subset', async () => {
    await expect(scanCustomerModuleWasm(wasiImport('args_sizes_get'))).resolves.toMatchObject({
      imports: ['wasi_snapshot_preview1.args_sizes_get'],
    });
    await expect(scanCustomerModuleWasm(wasiImport('sock_accept'))).rejects.toThrow(/forbidden WASM import/);
  });
});
