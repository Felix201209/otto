import { describe, expect, it } from 'vitest';
import { decodeCustomerModulePackageV1, encodeCustomerModulePackageV1 } from './customerModulePackage.js';

describe('customer module deterministic package', () => {
  it('encodes equivalent maps into identical bytes and decodes the versioned format', () => {
    const manifest = { schemaVersion: 1, id: 'com.acme.package', files: { 'z.wasm': 'z', 'a.svg': 'a' } } as never;
    const first = encodeCustomerModulePackageV1({ manifest, files: { 'z.wasm': 'eg==', 'a.svg': 'YQ==' } });
    const second = encodeCustomerModulePackageV1({ manifest, files: { 'a.svg': 'YQ==', 'z.wasm': 'eg==' } });
    expect(first).toEqual(second);
    expect(decodeCustomerModulePackageV1(first)).toMatchObject({ format: 'otto.customer-module-package.v1', manifest });
  });
});
