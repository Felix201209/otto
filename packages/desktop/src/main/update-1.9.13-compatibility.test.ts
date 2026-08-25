/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  resolveCheckOutcome,
  type UpdateManifest,
} from './update-core.js';

const manifest: UpdateManifest = {
  version: '1.9.13',
  notes: 'Otto 1.9.13 transition release',
  publishedAt: '2026-08-23T00:00:00.000Z',
  assets: {
    'win-x64': {
      name: 'Otto-Setup-1.9.13-win-x64.exe',
      url: 'https://59.110.154.44:7777/downloads/Otto-Setup-1.9.13-win-x64.exe',
      size: 236_706_516,
      sha256: 'a'.repeat(64),
    },
  },
};

describe('1.9.13 transition update compatibility', () => {
  it('offers 1.9.13 to an installed 1.9.12 client with the expected asset', () => {
    expect(compareVersions('1.9.12', '1.9.13')).toBe(-1);
    expect(
      resolveCheckOutcome(
        manifest,
        '1.9.12',
        'win-x64',
        'https://github.com/Felix201209/otto-releases/releases/tag/v1.9.13',
      ),
    ).toMatchObject({
      status: 'update-available',
      currentVersion: '1.9.12',
      version: '1.9.13',
      asset: {
        name: 'Otto-Setup-1.9.13-win-x64.exe',
      },
    });
  });

  it('does not downgrade a newer development installation to 1.9.13', () => {
    expect(compareVersions('1.10.1', '1.9.13')).toBe(1);
    expect(
      resolveCheckOutcome(
        manifest,
        '1.10.1',
        'win-x64',
        'https://github.com/Felix201209/otto-releases/releases/tag/v1.9.13',
      ),
    ).toEqual({
      status: 'up-to-date',
      currentVersion: '1.10.1',
      latestVersion: '1.9.13',
    });
  });
});
