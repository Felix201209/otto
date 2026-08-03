/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * NSI-07: distribution variant isolation — tests.
 *
 * Acceptance focus: Otto and Otto Green must not collide on any identity or
 * artifact field so they can install, log in, update and uninstall on the same
 * machine independently.
 */

import { describe, expect, it } from 'vitest';

import {
  blockmapName,
  macArtifactName,
  OTTO_GREEN_DISTRIBUTION,
  OTTO_GREEN_IDENTITY,
  OTTO_IDENTITY,
  OTTO_DISTRIBUTION,
  resolveDistribution,
  winArtifactName,
} from './distribution-config.mjs';

describe('otto / otto green distribution isolation (NSI-07)', () => {
  it('resolves Otto by default and Green via OTTO_GREEN=1', () => {
    expect(resolveDistribution({}).productName).toBe(OTTO_DISTRIBUTION);
    expect(resolveDistribution({ OTTO_GREEN: '0' }).productName).toBe(OTTO_DISTRIBUTION);
    expect(resolveDistribution({ OTTO_GREEN: '1' }).productName).toBe(
      OTTO_GREEN_DISTRIBUTION,
    );
    expect(resolveDistribution({ OTTO_GREEN: 'true' }).productName).toBe(
      OTTO_GREEN_DISTRIBUTION,
    );
  });

  it('isolates product name, app id and protocol scheme', () => {
    const o = OTTO_IDENTITY;
    const g = OTTO_GREEN_IDENTITY;
    expect(g.productName).not.toBe(o.productName);
    expect(g.appId).not.toBe(o.appId);
    expect(g.protocolScheme).not.toBe(o.protocolScheme);
    expect(g.protocolName).not.toBe(o.protocolName);
    expect(g.dataDirectoryName).not.toBe(o.dataDirectoryName);
    expect(g.distributionId).not.toBe(o.distributionId);
    expect(g.macBundleId).not.toBe(o.macBundleId);
  });

  it('produces distinct artifact names', () => {
    const o = OTTO_IDENTITY;
    const g = OTTO_GREEN_IDENTITY;
    expect(winArtifactName('1.2.3', 'x64', o)).toBe('Otto-Setup-1.2.3-win-x64.exe');
    expect(winArtifactName('1.2.3', 'x64', g)).toBe(
      'OttoGreen-Setup-1.2.3-win-x64.exe',
    );
    expect(macArtifactName('1.2.3', 'arm64', o)).toBe('Otto-1.2.3-arm64.dmg');
    expect(macArtifactName('1.2.3', 'arm64', g)).toBe('OttoGreen-1.2.3-arm64.dmg');
  });

  it('Green blockmap stays distinct from Otto', () => {
    const o = OTTO_IDENTITY;
    const g = OTTO_GREEN_IDENTITY;
    const oBase = winArtifactName('1.2.3', 'x64', o);
    const gBase = winArtifactName('1.2.3', 'x64', g);
    expect(blockmapName(gBase)).not.toBe(blockmapName(oBase));
    expect(blockmapName(gBase)).toBe('OttoGreen-Setup-1.2.3-win-x64.exe.blockmap');
  });

  it('every identity field is non-empty and well-formed', () => {
    for (const id of [OTTO_IDENTITY, OTTO_GREEN_IDENTITY]) {
      expect(id.productName.length).toBeGreaterThan(0);
      expect(id.appId).toMatch(/^[a-zA-Z0-9.]+$/);
      expect(id.protocolScheme).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(id.distributionId).toMatch(/^[a-z0-9-]+$/);
      expect(id.dataDirectoryName.length).toBeGreaterThan(0);
    }
  });
});
