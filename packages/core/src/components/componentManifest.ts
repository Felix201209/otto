/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

export type OttoComponentKind =
  | 'tool'
  | 'connector'
  | 'runtime'
  | 'agent-profile'
  | 'theme'
  | 'gui-shell';

export type OttoComponentUpdateOwner = 'kernel' | 'organization' | 'vendor';

export interface OttoComponentEntrypoints {
  tools?: string[];
  mcpServers?: string[];
  desktopRoutes?: string[];
  serverRoutes?: string[];
  themeTokens?: string[];
  runtimeBins?: string[];
}

export interface OttoComponentManifest {
  manifestVersion: 1;
  id: string;
  displayName: string;
  version: string;
  kind: OttoComponentKind;
  updateOwner: OttoComponentUpdateOwner;
  entrypoints: OttoComponentEntrypoints;
  permissions?: string[];
  description?: string;
}

export interface ComponentManifestValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const COMPONENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
const KERNEL_PATH_PATTERNS = [
  /^packages\/core\/src\/core\//,
  /^packages\/core\/src\/config\/config\.ts$/,
  /^packages\/core\/src\/tools\/tool-registry\.ts$/,
  /^packages\/core\/src\/policy\//,
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateStringArray(
  value: unknown,
  fieldName: string,
  errors: string[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array of strings`);
    return [];
  }
  const strings = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  if (strings.length !== value.length) {
    errors.push(`${fieldName} must contain only non-empty strings`);
  }
  return strings;
}

export function isKernelOwnedPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return KERNEL_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function validateComponentManifest(value: unknown): ComponentManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isPlainObject(value)) {
    return { ok: false, errors: ['manifest must be an object'], warnings };
  }

  if (value.manifestVersion !== 1) errors.push('manifestVersion must be 1');
  if (!hasNonEmptyString(value.id) || !COMPONENT_ID_PATTERN.test(value.id)) {
    errors.push('id must be 2-64 chars using lowercase letters, numbers, dots, underscores, or dashes');
  }
  if (!hasNonEmptyString(value.displayName)) errors.push('displayName is required');
  if (!hasNonEmptyString(value.version) || !VERSION_PATTERN.test(value.version)) {
    errors.push('version must be semantic version x.y.z');
  }

  const kinds: OttoComponentKind[] = ['tool', 'connector', 'runtime', 'agent-profile', 'theme', 'gui-shell'];
  if (!kinds.includes(value.kind as OttoComponentKind)) errors.push(`kind must be one of: ${kinds.join(', ')}`);

  const owners: OttoComponentUpdateOwner[] = ['kernel', 'organization', 'vendor'];
  if (!owners.includes(value.updateOwner as OttoComponentUpdateOwner)) {
    errors.push(`updateOwner must be one of: ${owners.join(', ')}`);
  }

  if (!isPlainObject(value.entrypoints)) {
    errors.push('entrypoints is required');
  } else {
    const entrypointPaths = [
      ...validateStringArray(value.entrypoints.tools, 'entrypoints.tools', errors),
      ...validateStringArray(value.entrypoints.mcpServers, 'entrypoints.mcpServers', errors),
      ...validateStringArray(value.entrypoints.desktopRoutes, 'entrypoints.desktopRoutes', errors),
      ...validateStringArray(value.entrypoints.serverRoutes, 'entrypoints.serverRoutes', errors),
      ...validateStringArray(value.entrypoints.themeTokens, 'entrypoints.themeTokens', errors),
      ...validateStringArray(value.entrypoints.runtimeBins, 'entrypoints.runtimeBins', errors),
    ];

    if (entrypointPaths.length === 0) {
      errors.push('entrypoints must declare at least one integration point');
    }

    const kernelPaths = entrypointPaths.filter(isKernelOwnedPath);
    if (kernelPaths.length > 0 && value.updateOwner !== 'kernel') {
      errors.push(`organization/vendor components must not own kernel paths: ${kernelPaths.join(', ')}`);
    }
  }

  const permissions = validateStringArray(value.permissions, 'permissions', errors);
  if ((value.kind === 'connector' || value.kind === 'runtime') && permissions.length === 0) {
    warnings.push(`${value.kind} components should declare permissions for enterprise review`);
  }

  return { ok: errors.length === 0, errors, warnings };
}
