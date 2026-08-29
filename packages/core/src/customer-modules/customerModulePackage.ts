import type { CustomerModuleManifestV1 } from './customerModuleManifest.js';

export const CUSTOMER_MODULE_PACKAGE_FORMAT_V1 = 'otto.customer-module-package.v1' as const;

export interface CustomerModulePackageV1 {
  format: typeof CUSTOMER_MODULE_PACKAGE_FORMAT_V1;
  manifest: CustomerModuleManifestV1;
  files: Record<string, string>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function encodeCustomerModulePackageV1(input: Omit<CustomerModulePackageV1, 'format'>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonical({ format: CUSTOMER_MODULE_PACKAGE_FORMAT_V1, ...input })));
}

export function decodeCustomerModulePackageV1(bytes: Uint8Array): CustomerModulePackageV1 {
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('customer module package root is invalid');
  const record = parsed as Record<string, unknown>;
  if (record.format !== CUSTOMER_MODULE_PACKAGE_FORMAT_V1 || !record.manifest || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)) {
    throw new Error('customer module package format is invalid');
  }
  return parsed as CustomerModulePackageV1;
}
