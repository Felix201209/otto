/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

export type KernelDistributionChannel = 'stable' | 'lts' | 'security' | 'internal';
export type KernelArtifactFormat = 'node-bundle' | 'native-binary' | 'electron-asar';

export interface KernelPerformanceBudget {
  coldStartMs: number;
  registryReadyMs: number;
  maxIdleRssMb: number;
  maxSubAgentRssDeltaMb: number;
  maxToolSchemaChars: number;
  maxDistributionMb: number;
}

export interface KernelDistributionManifest {
  manifestVersion: 1;
  kernelVersion: string;
  sourceCommit: string;
  channel: KernelDistributionChannel;
  artifact: {
    format: KernelArtifactFormat;
    path: string;
    sha256: string;
    signature: string;
    publicKeyId: string;
    sourceIncluded: boolean;
    minNodeVersion?: string;
  };
  performanceBudget: KernelPerformanceBudget;
  componentApiVersion: number;
  generatedAt: string;
}

export interface KernelDistributionValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
const COMMIT_PATTERN = /^[a-f0-9]{12,40}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const KEY_ID_PATTERN = /^[a-zA-Z0-9._:-]{6,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/=_:.-]{32,4096}$/;

export const ENTERPRISE_KERNEL_PERFORMANCE_FLOOR: KernelPerformanceBudget = {
  coldStartMs: 1200,
  registryReadyMs: 500,
  maxIdleRssMb: 180,
  maxSubAgentRssDeltaMb: 80,
  maxToolSchemaChars: 120000,
  maxDistributionMb: 10,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePositiveNumber(value: unknown, name: string, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${name} must be a positive number`);
    return undefined;
  }
  return value;
}

export function validateKernelDistributionManifest(
  value: unknown,
): KernelDistributionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isObject(value)) {
    return { ok: false, errors: ['manifest must be an object'], warnings };
  }

  if (value.manifestVersion !== 1) errors.push('manifestVersion must be 1');
  if (!isNonEmptyString(value.kernelVersion) || !SEMVER_PATTERN.test(value.kernelVersion)) {
    errors.push('kernelVersion must be semantic version x.y.z');
  }
  if (!isNonEmptyString(value.sourceCommit) || !COMMIT_PATTERN.test(value.sourceCommit)) {
    errors.push('sourceCommit must be a 12-40 character git commit hash');
  }

  const channels: KernelDistributionChannel[] = ['stable', 'lts', 'security', 'internal'];
  if (!channels.includes(value.channel as KernelDistributionChannel)) {
    errors.push(`channel must be one of: ${channels.join(', ')}`);
  }

  if (!isObject(value.artifact)) {
    errors.push('artifact is required');
  } else {
    const formats: KernelArtifactFormat[] = ['node-bundle', 'native-binary', 'electron-asar'];
    if (!formats.includes(value.artifact.format as KernelArtifactFormat)) {
      errors.push(`artifact.format must be one of: ${formats.join(', ')}`);
    }
    if (!isNonEmptyString(value.artifact.path)) errors.push('artifact.path is required');
    if (!isNonEmptyString(value.artifact.sha256) || !SHA256_PATTERN.test(value.artifact.sha256)) {
      errors.push('artifact.sha256 must be a 64-character SHA-256 hex digest');
    }
    if (!isNonEmptyString(value.artifact.signature) || !SIGNATURE_PATTERN.test(value.artifact.signature)) {
      errors.push('artifact.signature must be a detached signature string');
    }
    if (!isNonEmptyString(value.artifact.publicKeyId) || !KEY_ID_PATTERN.test(value.artifact.publicKeyId)) {
      errors.push('artifact.publicKeyId must identify the trusted kernel signing key');
    }
    if (value.artifact.sourceIncluded !== false) {
      errors.push('locked enterprise kernels must set artifact.sourceIncluded=false');
    }
    if (
      isNonEmptyString(value.artifact.path) &&
      /\.(ts|tsx|js|mjs|cjs)$/i.test(value.artifact.path) &&
      value.artifact.format === 'native-binary'
    ) {
      errors.push('native-binary artifacts must not point to source-like script files');
    }
  }

  if (!isObject(value.performanceBudget)) {
    errors.push('performanceBudget is required');
  } else {
    const budget = value.performanceBudget;
    const coldStartMs = validatePositiveNumber(budget.coldStartMs, 'performanceBudget.coldStartMs', errors);
    const registryReadyMs = validatePositiveNumber(budget.registryReadyMs, 'performanceBudget.registryReadyMs', errors);
    const maxIdleRssMb = validatePositiveNumber(budget.maxIdleRssMb, 'performanceBudget.maxIdleRssMb', errors);
    const maxSubAgentRssDeltaMb = validatePositiveNumber(budget.maxSubAgentRssDeltaMb, 'performanceBudget.maxSubAgentRssDeltaMb', errors);
    const maxToolSchemaChars = validatePositiveNumber(budget.maxToolSchemaChars, 'performanceBudget.maxToolSchemaChars', errors);
    const maxDistributionMb = validatePositiveNumber(budget.maxDistributionMb, 'performanceBudget.maxDistributionMb', errors);

    if (coldStartMs && coldStartMs > ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.coldStartMs) {
      warnings.push(`coldStartMs exceeds enterprise floor (${ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.coldStartMs}ms)`);
    }
    if (registryReadyMs && registryReadyMs > ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.registryReadyMs) {
      warnings.push(`registryReadyMs exceeds enterprise floor (${ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.registryReadyMs}ms)`);
    }
    if (maxIdleRssMb && maxIdleRssMb > ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxIdleRssMb) {
      warnings.push(`maxIdleRssMb exceeds enterprise floor (${ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxIdleRssMb}MB)`);
    }
    if (maxSubAgentRssDeltaMb && maxSubAgentRssDeltaMb > ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxSubAgentRssDeltaMb) {
      warnings.push(`maxSubAgentRssDeltaMb exceeds enterprise floor (${ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxSubAgentRssDeltaMb}MB)`);
    }
    if (maxToolSchemaChars && maxToolSchemaChars > ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxToolSchemaChars) {
      warnings.push(`maxToolSchemaChars exceeds enterprise floor (${ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxToolSchemaChars})`);
    }
    if (maxDistributionMb && maxDistributionMb > ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxDistributionMb) {
      warnings.push(`maxDistributionMb exceeds enterprise floor (${ENTERPRISE_KERNEL_PERFORMANCE_FLOOR.maxDistributionMb}MB)`);
    }
  }

  const componentApiVersion = validatePositiveNumber(value.componentApiVersion, 'componentApiVersion', errors);
  if (componentApiVersion && !Number.isInteger(componentApiVersion)) {
    errors.push('componentApiVersion must be an integer');
  }

  if (!isNonEmptyString(value.generatedAt) || Number.isNaN(Date.parse(value.generatedAt))) {
    errors.push('generatedAt must be an ISO timestamp');
  }

  return { ok: errors.length === 0, errors, warnings };
}
