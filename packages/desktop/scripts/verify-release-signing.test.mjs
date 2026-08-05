/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { inspectReleaseSigningConfig } from './verify-release-signing.mjs';
describe('release signing policy', () => {
  it('blocks official release mode without platform credentials', () => {
    const result = inspectReleaseSigningConfig({ env: {}, mode: 'release' });
    expect(result.ok).toBe(false); expect(result.blocked).toBe(true);
    expect(result.missing).toEqual(expect.arrayContaining(['windows: WIN_CSC_LINK (or the configured certificate secret)', 'macos: APPLE_ID', 'macos: APPLE_APP_SPECIFIC_PASSWORD', 'macos: APPLE_TEAM_ID', 'macos: CSC_LINK or CSC_NAME']));
  });
  it('accepts declared inputs without claiming signatures were produced', () => {
    const result = inspectReleaseSigningConfig({ env: { WIN_CSC_LINK: 'file:///tmp/test.p12', APPLE_ID: 'release@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'app-password', APPLE_TEAM_ID: 'TEAM123', CSC_NAME: 'Developer ID Application: Otto' }, mode: 'release' });
    expect(result.ok).toBe(true);
  });
  it('keeps local simulation explicitly blocked', () => {
    const result = inspectReleaseSigningConfig({ env: {}, mode: 'local-simulate' });
    expect(result.ok).toBe(false); expect(result.blocked).toBe(true); expect(result.message).toContain('does not create or validate');
  });
});
