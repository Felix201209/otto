/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import {
  checkForUpdateUsingPolicy,
  resolveDesktopDistribution,
  type UpdatePolicyAdapterOptions,
} from './update-policy-adapter.js';

const reference = { url: 'https://updates.example.test/latest.json', sha256: 'a'.repeat(64) };

function resolved(overrides: Record<string, unknown> = {}) {
  return {
    status: 'resolved' as const,
    verifiedKeyId: 'key-1',
    policy: {
      version: 1 as const,
      deploymentId: 'dep_1',
      distributionId: 'otto-green',
      currentVersion: '1.9.10',
      decision: 'update' as const,
      reason: 'update_available' as const,
      release: {
        id: 'rel_1',
        version: '1.9.11',
        sourceCommit: 'abcdef1',
        channel: 'stable' as const,
        mandatory: false,
        rolloutPercent: 100,
        notes: '',
        fullManifest: reference,
        incrementalManifest: null,
        publishedAt: '2026-07-31T00:00:00.000Z',
      },
      issuedAtMs: 1,
      expiresAtMs: 2,
      ...overrides,
    },
  };
}

function options(): UpdatePolicyAdapterOptions {
  return {
    distributionId: 'otto-green',
    currentVersion: '1.9.10',
    hasEnterpriseSession: true,
    resolvePolicy: vi.fn(async () => resolved()),
    checkLegacy: vi.fn(async () => ({
      status: 'up-to-date' as const,
      currentVersion: '1.9.10',
      latestVersion: null,
    })),
    checkManagedFull: vi.fn(async () => ({
      status: 'update-available' as const,
      currentVersion: '1.9.10',
      version: '1.9.11',
      notes: '',
      publishedAt: null,
      asset: null,
      releasePageUrl: reference.url,
    })),
    checkIncremental: vi.fn(async () => ({
      status: 'up-to-date' as const,
      appVersion: '1.9.10',
    })),
  };
}

describe('desktop signed update policy adapter', () => {
  it('derives stable Otto and Otto Green distribution ids', () => {
    expect(resolveDesktopDistribution(undefined, 'Otto')).toBe('otto');
    expect(resolveDesktopDistribution(undefined, 'otto.green')).toBe('otto-green');
    expect(resolveDesktopDistribution('customer-a', 'Otto')).toBe('customer-a');
    expect(resolveDesktopDistribution('../bad', 'Otto Green')).toBe('otto-green');
  });

  it('uses only the managed manifest for an approved release', async () => {
    const input = options();
    await expect(checkForUpdateUsingPolicy(input)).resolves.toMatchObject({
      status: 'update-available',
      version: '1.9.11',
    });
    expect(input.checkManagedFull).toHaveBeenCalledWith(reference);
    expect(input.checkLegacy).not.toHaveBeenCalled();
  });

  it('does not cross-fallback Otto Green to the public Otto channel', async () => {
    const input = options();
    input.hasEnterpriseSession = false;
    await expect(checkForUpdateUsingPolicy(input)).resolves.toMatchObject({
      status: 'check-failed',
    });
    expect(input.checkLegacy).not.toHaveBeenCalled();
  });

  it('keeps legacy Otto updates compatible when control is not configured', async () => {
    const input = options();
    input.distributionId = 'otto';
    input.resolvePolicy = vi.fn(async () => ({
      status: 'not_configured' as const,
      reason: 'online_license_required' as const,
    }));
    await checkForUpdateUsingPolicy(input);
    expect(input.checkLegacy).toHaveBeenCalledOnce();
  });

  it('fails closed when an authoritative control service is unavailable', async () => {
    const input = options();
    input.distributionId = 'otto';
    input.resolvePolicy = vi.fn(async () => ({
      status: 'unavailable' as const,
      error: 'signature invalid',
    }));
    await expect(checkForUpdateUsingPolicy(input)).resolves.toMatchObject({
      status: 'check-failed',
      message: expect.stringContaining('signature invalid'),
    });
    expect(input.checkLegacy).not.toHaveBeenCalled();
  });
});
