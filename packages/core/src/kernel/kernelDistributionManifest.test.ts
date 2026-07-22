/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ENTERPRISE_KERNEL_PERFORMANCE_FLOOR,
  validateKernelDistributionManifest,
  type KernelDistributionManifest,
} from './kernelDistributionManifest.js';

const VALID_MANIFEST: KernelDistributionManifest = {
  manifestVersion: 1,
  kernelVersion: '2.0.0',
  sourceCommit: 'ffd69a433bd7924f9cf60b64d539ab7a818353c7',
  channel: 'lts',
  artifact: {
    format: 'native-binary',
    path: 'dist/otto-kernel.exe',
    sha256: 'a'.repeat(64),
    signature: 'ed25519:' + 'b'.repeat(96),
    publicKeyId: 'otto-kernel-prod-2026',
    sourceIncluded: false,
    minNodeVersion: '20.0.0',
  },
  performanceBudget: {
    coldStartMs: 900,
    registryReadyMs: 350,
    maxIdleRssMb: 150,
    maxSubAgentRssDeltaMb: 60,
    maxToolSchemaChars: 90000,
    maxDistributionMb: 10,
  },
  componentApiVersion: 1,
  generatedAt: '2026-07-22T11:00:00.000Z',
};

describe('kernelDistributionManifest', () => {
  it('accepts a signed compiled enterprise kernel artifact', () => {
    expect(validateKernelDistributionManifest(VALID_MANIFEST)).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it('rejects locked enterprise kernels that include source', () => {
    const result = validateKernelDistributionManifest({
      ...VALID_MANIFEST,
      artifact: {
        ...VALID_MANIFEST.artifact,
        sourceIncluded: true,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('locked enterprise kernels must set artifact.sourceIncluded=false');
  });

  it('rejects unsigned or weakly identified artifacts', () => {
    const result = validateKernelDistributionManifest({
      ...VALID_MANIFEST,
      artifact: {
        ...VALID_MANIFEST.artifact,
        sha256: 'not-a-digest',
        signature: 'short',
        publicKeyId: 'k',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('artifact.sha256');
    expect(result.errors.join('\n')).toContain('artifact.signature');
    expect(result.errors.join('\n')).toContain('artifact.publicKeyId');
  });

  it('rejects native binary manifests pointing to source-like scripts', () => {
    const result = validateKernelDistributionManifest({
      ...VALID_MANIFEST,
      artifact: {
        ...VALID_MANIFEST.artifact,
        path: 'dist/otto-kernel.js',
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('native-binary artifacts must not point to source-like script files');
  });

  it('warns when performance budgets miss the enterprise floor', () => {
    const result = validateKernelDistributionManifest({
      ...VALID_MANIFEST,
      performanceBudget: {
        coldStartMs: ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.coldStartMs + 1,
        registryReadyMs: ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.registryReadyMs + 1,
        maxIdleRssMb: ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxIdleRssMb + 1,
        maxSubAgentRssDeltaMb: ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxSubAgentRssDeltaMb + 1,
        maxToolSchemaChars: ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxToolSchemaChars + 1,
        maxDistributionMb: ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxDistributionMb + 1,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(6);
    expect(result.warnings.join('\n')).toContain('maxDistributionMb');
  });
});
