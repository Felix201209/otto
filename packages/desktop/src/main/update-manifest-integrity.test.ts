/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseVerifiedManifestJson } from './update-manifest-integrity.js';

describe('managed update manifest integrity', () => {
  it('accepts the exact signed-policy manifest bytes', () => {
    const text = JSON.stringify({ version: '1.9.11', assets: {} });
    const sha256 = createHash('sha256').update(text).digest('hex');
    expect(parseVerifiedManifestJson(text, sha256)).toEqual({
      ok: true,
      json: { version: '1.9.11', assets: {} },
    });
  });

  it('rejects changed bytes and invalid JSON', () => {
    expect(parseVerifiedManifestJson('{"version":"changed"}', 'a'.repeat(64))).toMatchObject({
      ok: false,
      error: expect.stringContaining('SHA-256'),
    });
    expect(parseVerifiedManifestJson('not-json')).toMatchObject({ ok: false });
  });
});
