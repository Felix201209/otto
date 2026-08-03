/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-07: Green electron-builder override args — tests.
 */

import { describe, expect, it } from 'vitest';

import { greenBuilderArgs, greenReleaseTag } from './build-green-args.mjs';
import { OTTO_GREEN_IDENTITY } from './distribution-config.mjs';

function toMap(args) {
  return new Map(args.map((a) => a.replace('--config.', '').split('=', 2)));
}

describe('green builder args (NSI-07)', () => {
  it('overrides every identity field that must differ from Otto', () => {
    const map = toMap(greenBuilderArgs(OTTO_GREEN_IDENTITY));
    expect(map.get('productName')).toBe('Otto Green');
    expect(map.get('appId')).toBe('ai.otto.green.desktop');
    expect(map.get('protocols[0].schemes[0]')).toBe('otto-green');
    expect(map.get('nsis.shortcutName')).toBe('Otto Green');
    expect(map.get('extraMetadata.name')).toBe('otto-green-desktop');
    expect(map.get('extraMetadata.productName')).toBe('Otto Green');
  });

  it('uses artifact tokens that keep files distinct from Otto', () => {
    const map = toMap(greenBuilderArgs(OTTO_GREEN_IDENTITY));
    expect(map.get('mac.artifactName')).toContain('OttoGreen-');
    expect(map.get('nsis.artifactName')).toContain('OttoGreen-Setup-');
    // Must NOT reference the plain Otto artifact token.
    expect(map.get('mac.artifactName')).not.toMatch(/^Otto-\\\$/);
  });

  it('respects the Green release tag convention', () => {
    expect(greenReleaseTag('1.10.0')).toBe('v1.10.0-green');
  });

  it('emits only --config.* override flags', () => {
    for (const arg of greenBuilderArgs(OTTO_GREEN_IDENTITY)) {
      expect(arg.startsWith('--config.')).toBe(true);
    }
  });
});
