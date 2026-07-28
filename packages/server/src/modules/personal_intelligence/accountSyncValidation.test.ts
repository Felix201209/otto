/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeAccountSyncPayload } from './accountSyncValidation.js';

function file(path: string, content = 'content') {
  return {
    path,
    content,
    modifiedAtMs: Date.parse('2026-07-26T10:00:00.000Z'),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function payload(files: Array<ReturnType<typeof file>>) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-26T10:00:00.000Z',
    files,
  };
}

describe('account sync payload validation', () => {
  it('normalizes legacy personal-memory paths without changing content', () => {
    expect(
      normalizeAccountSyncPayload(
        'personal_memory',
        payload([file('global.md'), file('sessions/session-1.md')]),
      ).files.map((entry) => entry.path),
    ).toEqual(['memory/global.md', 'memory/sessions/session-1.md']);
  });

  it('rejects traversal, duplicate normalized paths and unsupported files', () => {
    expect(() =>
      normalizeAccountSyncPayload(
        'worklog',
        payload([file('../outside.json')]),
      ),
    ).toThrow('account sync file path is not allowed');
    expect(() =>
      normalizeAccountSyncPayload(
        'personal_memory',
        payload([file('global.md'), file('memory/global.md')]),
      ),
    ).toThrow('account sync payload contains a duplicate path');
    expect(() =>
      normalizeAccountSyncPayload(
        'auto_skills',
        payload([file('auto-example/private.txt')]),
      ),
    ).toThrow('account sync file path is not allowed');
  });

  it('rejects a checksum that does not match the supplied content', () => {
    const entry = file('memory/global.md');
    expect(() =>
      normalizeAccountSyncPayload('personal_memory', {
        ...payload([entry]),
        files: [{ ...entry, sha256: '0'.repeat(64) }],
      }),
    ).toThrow('account sync file checksum mismatch');
  });
});
