export const CUSTOMER_MODULE_HOST_API_V1 = 'otto.customer-module.v1' as const;
export const CUSTOMER_MODULE_MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

export type CustomerModuleReviewStatus =
  | 'draft'
  | 'scanning'
  | 'review'
  | 'approved'
  | 'rejected'
  | 'suspended'
  | 'withdrawn';

export type CustomerModuleOutput = 'text' | 'json' | 'file' | 'table';

export type CustomerModulePermission =
  | { kind: 'model'; paid: boolean }
  | { kind: 'http'; hosts: string[]; writes: boolean }
  | { kind: 'file'; access: 'user-selected-read' | 'user-selected-write' }
  | { kind: 'storage'; access: 'read' | 'read-write' }
  | { kind: 'background'; defaultEnabled: false };

export interface CustomerModuleManifestV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  publisher: { id: string; name: string };
  description: string;
  releaseNotes?: string;
  icon: string;
  entrypoint: string;
  hostApi: typeof CUSTOMER_MODULE_HOST_API_V1;
  minimumOttoVersion: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  outputs: CustomerModuleOutput[];
  permissions: CustomerModulePermission[];
  files: Record<string, string>;
  signature?: { algorithm: 'ed25519'; keyId: string; value: string };
}

export interface CustomerModuleArchiveEntry {
  path: string;
  kind: 'file' | 'directory' | 'symlink';
  size: number;
}

const MODULE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0]+$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function fail(message: string): never {
  throw new Error(`invalid customer module manifest: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || value.startsWith('.')) {
    fail(`${field} has unsafe path`);
  }
  return value;
}

export function parseCustomerModuleManifest(
  value: unknown,
  options: { requireSignature?: boolean } = { requireSignature: true },
): CustomerModuleManifestV1 {
  if (!isObject(value)) fail('root must be an object');
  const manifest = value as unknown as CustomerModuleManifestV1;
  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (!MODULE_ID.test(manifest.id)) fail('id must be a stable reverse-domain identifier');
  if (!manifest.name?.trim() || manifest.name.length > 80) fail('name is required and limited to 80 characters');
  if (!SEMVER.test(manifest.version) || !SEMVER.test(manifest.minimumOttoVersion)) fail('versions must use semver');
  if (!manifest.publisher?.id?.trim() || !manifest.publisher?.name?.trim()) fail('publisher is required');
  if (!manifest.description?.trim() || manifest.description.length > 2_000) fail('description is required');
  if (manifest.releaseNotes !== undefined && (typeof manifest.releaseNotes !== 'string' || manifest.releaseNotes.length > 4_000)) fail('release notes are invalid');
  safePath(manifest.icon, 'icon');
  if (!safePath(manifest.entrypoint, 'entrypoint').endsWith('.wasm')) fail('entrypoint must be WASM');
  if (manifest.hostApi !== CUSTOMER_MODULE_HOST_API_V1) fail('unknown host ABI');
  if (!isObject(manifest.inputSchema) || manifest.inputSchema.type !== 'object' || !isObject(manifest.inputSchema.properties)) {
    fail('inputSchema must be a declarative object schema');
  }
  const inputProperties = Object.entries(manifest.inputSchema.properties);
  if (inputProperties.length > 100) fail('inputSchema has too many fields');
  for (const [name, property] of inputProperties) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(name) || !isObject(property)
      || !['string', 'number', 'integer', 'boolean'].includes(String(property.type))
      || (property.title !== undefined && (typeof property.title !== 'string' || property.title.length > 120))) {
      fail('inputSchema contains an unsupported field');
    }
  }
  if (manifest.inputSchema.required !== undefined && (
    !Array.isArray(manifest.inputSchema.required)
    || manifest.inputSchema.required.some((name) => typeof name !== 'string' || !(name in manifest.inputSchema.properties))
  )) fail('inputSchema required fields must reference declared properties');
  if (!Array.isArray(manifest.outputs) || manifest.outputs.length === 0 || manifest.outputs.some(
    (output) => !['text', 'json', 'file', 'table'].includes(output),
  )) fail('outputs are invalid');
  if (!Array.isArray(manifest.permissions)) fail('permissions must be an array');
  const permissionKinds = new Set<string>();
  for (const permission of manifest.permissions) {
    if (!isObject(permission) || typeof permission.kind !== 'string') fail('permission is invalid');
    if (permissionKinds.has(permission.kind)) fail('permission kinds must not be duplicated');
    permissionKinds.add(permission.kind);
    if (permission.kind === 'background' && permission.defaultEnabled !== false) fail('background must default off');
    if (permission.kind === 'http') {
      if (!Array.isArray(permission.hosts) || permission.hosts.length === 0 || permission.hosts.some(
        (host) => typeof host !== 'string' || !HOST.test(host),
      )) fail('HTTP hosts must be explicit DNS names');
      if (typeof permission.writes !== 'boolean') fail('HTTP writes declaration is required');
    } else if (permission.kind === 'model' && typeof permission.paid !== 'boolean') {
      fail('model paid declaration is required');
    } else if (permission.kind === 'file' && !['user-selected-read', 'user-selected-write'].includes(String(permission.access))) {
      fail('file access must use a user-selected scope');
    } else if (permission.kind === 'storage' && !['read', 'read-write'].includes(String(permission.access))) {
      fail('storage access is invalid');
    } else if (!['model', 'file', 'storage', 'background'].includes(permission.kind)) {
      fail('unknown permission');
    }
  }
  if (!isObject(manifest.files) || Object.keys(manifest.files).length === 0) fail('files are required');
  for (const [path, digest] of Object.entries(manifest.files)) {
    safePath(path, 'files');
    if (!SHA256.test(digest)) fail('file hashes must be lowercase SHA-256');
  }
  if (!manifest.files[manifest.entrypoint] || !manifest.files[manifest.icon]) fail('entrypoint and icon must be declared');
  if (options.requireSignature !== false && (
    manifest.signature?.algorithm !== 'ed25519'
    || !manifest.signature.keyId?.trim()
    || !manifest.signature.value?.startsWith('ed25519:')
  )) {
    fail('an Ed25519 marketplace signature is required');
  }
  if (manifest.signature && (
    manifest.signature.algorithm !== 'ed25519'
    || !manifest.signature.keyId?.trim()
    || !manifest.signature.value?.startsWith('ed25519:')
  )) fail('marketplace signature is invalid');
  return manifest;
}

export function validateCustomerModuleArchiveEntries(
  rawManifest: unknown,
  entries: readonly CustomerModuleArchiveEntry[],
  options: { requireSignature?: boolean } = { requireSignature: true },
): void {
  const manifest = parseCustomerModuleManifest(rawManifest, options);
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const path = safePath(entry.path, 'archive entry');
    if (seen.has(path)) fail('archive contains duplicate path');
    seen.add(path);
    if (entry.kind === 'symlink') fail('archive may not contain symlink');
    if (entry.kind === 'directory') continue;
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) fail('archive entry size is invalid');
    total += entry.size;
    if (!(path in manifest.files)) fail('archive contains undeclared file');
  }
  if (total > CUSTOMER_MODULE_MAX_ARCHIVE_BYTES) fail('archive exceeds size limit');
  for (const path of Object.keys(manifest.files)) {
    if (!seen.has(path)) fail('archive is missing a declared file');
  }
}
