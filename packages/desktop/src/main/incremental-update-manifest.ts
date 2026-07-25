/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

export type IncrementalUpdateKind = 'patch' | 'kernel' | 'component';
export type IncrementalRestartPolicy = 'none' | 'renderer' | 'server' | 'app';

export interface IncrementalUpdateArtifact {
  id: string;
  kind: IncrementalUpdateKind;
  version: string;
  target: string;
  compat: {
    appVersion: string;
    sourceCommit?: string;
    kernelAbi?: string;
    componentApi?: string;
  };
  url: string;
  size: number;
  sha256: string;
  signature: string;
  restart: IncrementalRestartPolicy;
  rollback: {
    supported: boolean;
    receipt: boolean;
  };
}

export interface IncrementalUpdateManifest {
  schemaVersion: 1;
  appVersion: string;
  sourceCommit: string;
  publishedAt: string;
  channels: {
    patch: IncrementalUpdateArtifact[];
    kernel: IncrementalUpdateArtifact[];
    component: IncrementalUpdateArtifact[];
  };
}

export type IncrementalManifestParseResult =
  | { ok: true; manifest: IncrementalUpdateManifest }
  | { ok: false; error: string };

const SHA256_RE = /^[a-f0-9]{64}$/;
const KINDS: IncrementalUpdateKind[] = ['patch', 'kernel', 'component'];
const RESTART_POLICIES: IncrementalRestartPolicy[] = ['none', 'renderer', 'server', 'app'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateArtifact(
  value: unknown,
  expectedKind: IncrementalUpdateKind,
  manifestAppVersion: string,
): IncrementalUpdateArtifact | string {
  if (!isRecord(value)) return `${expectedKind} artifact must be an object`;
  if (value.kind !== expectedKind) return `${expectedKind} artifact kind mismatch`;

  const id = value.id;
  const version = value.version;
  const target = value.target;
  const artifactUrl = value.url;
  const sha256 = value.sha256;
  const signature = value.signature;
  for (const [field, fieldValue] of Object.entries({
    id,
    version,
    target,
    url: artifactUrl,
    sha256,
    signature,
  })) {
    if (!isNonEmptyString(fieldValue)) return `${expectedKind} artifact missing ${field}`;
  }
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0) {
    return `${expectedKind} artifact size must be a positive integer`;
  }
  const artifactSha256 = sha256 as string;
  const artifactUrlString = artifactUrl as string;
  if (!SHA256_RE.test(artifactSha256)) return `${expectedKind} artifact sha256 must be lowercase hex`;
  if (!RESTART_POLICIES.includes(value.restart as IncrementalRestartPolicy)) {
    return `${expectedKind} artifact restart policy is invalid`;
  }
  try {
    const url = new URL(artifactUrlString);
    if (url.protocol !== 'https:') return `${expectedKind} artifact url must use https`;
  } catch {
    return `${expectedKind} artifact url is invalid`;
  }
  if (!isRecord(value.compat)) return `${expectedKind} artifact compat must be an object`;
  if (value.compat.appVersion !== manifestAppVersion) {
    return `${expectedKind} artifact compat.appVersion must match manifest appVersion`;
  }
  if (!isRecord(value.rollback)) return `${expectedKind} artifact rollback must be an object`;
  if (typeof value.rollback.supported !== 'boolean' || typeof value.rollback.receipt !== 'boolean') {
    return `${expectedKind} artifact rollback flags must be boolean`;
  }

  return {
    id: id as string,
    kind: expectedKind,
    version: version as string,
    target: target as string,
    compat: value.compat as IncrementalUpdateArtifact['compat'],
    url: artifactUrlString,
    size: value.size,
    sha256: artifactSha256,
    signature: signature as string,
    restart: value.restart as IncrementalRestartPolicy,
    rollback: value.rollback as IncrementalUpdateArtifact['rollback'],
  };
}

export function parseIncrementalUpdateManifest(value: unknown): IncrementalManifestParseResult {
  if (!isRecord(value)) return { ok: false, error: 'manifest must be an object' };
  if (value.schemaVersion !== 1) return { ok: false, error: 'schemaVersion must be 1' };
  for (const field of ['appVersion', 'sourceCommit', 'publishedAt'] as const) {
    if (!isNonEmptyString(value[field])) return { ok: false, error: `manifest missing ${field}` };
  }

  const appVersion = value.appVersion as string;
  const sourceCommit = value.sourceCommit as string;
  const publishedAt = value.publishedAt as string;
  if (!isNonEmptyString(appVersion) || !isNonEmptyString(sourceCommit) || !isNonEmptyString(publishedAt)) {
    return { ok: false, error: 'manifest metadata must be non-empty strings' };
  }
  if (Number.isNaN(Date.parse(publishedAt))) {
    return { ok: false, error: 'publishedAt must be an ISO date string' };
  }
  if (!isRecord(value.channels)) return { ok: false, error: 'channels must be an object' };

  const channels: IncrementalUpdateManifest['channels'] = { patch: [], kernel: [], component: [] };
  for (const kind of KINDS) {
    const entries = value.channels[kind];
    if (!Array.isArray(entries)) return { ok: false, error: `channels.${kind} must be an array` };
    for (const entry of entries) {
      const parsed = validateArtifact(entry, kind, appVersion);
      if (typeof parsed === 'string') return { ok: false, error: parsed };
      channels[kind].push(parsed);
    }
  }

  return {
    ok: true,
    manifest: {
      schemaVersion: 1,
      appVersion,
      sourceCommit,
      publishedAt,
      channels,
    },
  };
}
