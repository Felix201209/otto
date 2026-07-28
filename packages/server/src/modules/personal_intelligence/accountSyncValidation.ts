/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ACCOUNT_SYNC_SCOPES,
  type AccountSyncFile,
  type AccountSyncPayload,
  type AccountSyncScope,
} from './accountSyncTypes.js';

const ACCOUNT_SYNC_MAX_FILES = 1_000;
const ACCOUNT_SYNC_MAX_FILE_BYTES = 1024 * 1024;
const ACCOUNT_SYNC_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const ACCOUNT_SYNC_SCOPE_SET = new Set<string>(ACCOUNT_SYNC_SCOPES);

function hashesMatch(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  } catch {
    return false;
  }
}

function normalizeAccountSyncPath(
  scope: AccountSyncScope,
  value: string,
): string {
  if (scope !== 'personal_memory') return value;
  if (value === 'global.md') return 'memory/global.md';
  if (value.startsWith('sessions/')) return `memory/${value}`;
  return value;
}

function isAccountSyncPathAllowed(
  scope: AccountSyncScope,
  value: string,
): boolean {
  if (
    !value ||
    value.length > 260 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return false;
  }
  if (scope === 'personal_memory') {
    return (
      value === 'memory/global.md' ||
      /^memory\/sessions\/[^/]{1,160}\.md$/u.test(value) ||
      value === 'knowledge/entries.jsonl'
    );
  }
  if (scope === 'worklog') {
    return /\.(?:jsonl|json|md)$/iu.test(value);
  }
  return /^auto-[^/]{1,160}\/(?:SKILL\.md|profile\.json)$/u.test(value);
}

export function isAccountSyncScope(value: string): value is AccountSyncScope {
  return ACCOUNT_SYNC_SCOPE_SET.has(value);
}

export function normalizeAccountSyncPayload(
  scope: AccountSyncScope,
  value: unknown,
): AccountSyncPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('account sync payload must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.files)) {
    throw new Error('account sync payload schema is unsupported');
  }
  if (raw.files.length > ACCOUNT_SYNC_MAX_FILES) {
    throw new Error('account sync payload contains too many files');
  }
  const generatedAtMs = Date.parse(String(raw.generatedAt ?? ''));
  if (!Number.isFinite(generatedAtMs)) {
    throw new Error('account sync generatedAt is invalid');
  }

  let totalBytes = 0;
  const seen = new Set<string>();
  const files = raw.files.map((candidate): AccountSyncFile => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw new Error('account sync file entry is invalid');
    }
    const file = candidate as Record<string, unknown>;
    const relativePath = normalizeAccountSyncPath(
      scope,
      typeof file.path === 'string' ? file.path : '',
    );
    const content = typeof file.content === 'string' ? file.content : '';
    if (!isAccountSyncPathAllowed(scope, relativePath)) {
      throw new Error('account sync file path is not allowed');
    }
    if (seen.has(relativePath)) {
      throw new Error('account sync payload contains a duplicate path');
    }
    seen.add(relativePath);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > ACCOUNT_SYNC_MAX_FILE_BYTES) {
      throw new Error('account sync file exceeds the size limit');
    }
    totalBytes += contentBytes + Buffer.byteLength(relativePath, 'utf8');
    if (totalBytes > ACCOUNT_SYNC_MAX_PAYLOAD_BYTES) {
      throw new Error('account sync payload exceeds the size limit');
    }
    const modifiedAtMs = Number(file.modifiedAtMs);
    if (!Number.isFinite(modifiedAtMs) || modifiedAtMs < 0) {
      throw new Error('account sync file timestamp is invalid');
    }
    const digest = createHash('sha256').update(content, 'utf8').digest('hex');
    if (
      typeof file.sha256 !== 'string' ||
      !hashesMatch(digest, file.sha256.toLowerCase())
    ) {
      throw new Error('account sync file checksum mismatch');
    }
    return {
      path: relativePath,
      content,
      modifiedAtMs: Math.floor(modifiedAtMs),
      sha256: digest,
    };
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    files,
    ...(raw.truncated === true ? { truncated: true } : {}),
  };
}
