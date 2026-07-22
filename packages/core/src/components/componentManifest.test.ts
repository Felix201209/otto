/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isKernelOwnedPath,
  validateComponentManifest,
  type OttoComponentManifest,
} from './componentManifest.js';

describe('componentManifest', () => {
  it('accepts an organization-owned GUI shell component outside the kernel', () => {
    const manifest: OttoComponentManifest = {
      manifestVersion: 1,
      id: 'gov.local.gui',
      displayName: 'Local Government GUI',
      version: '1.0.0',
      kind: 'gui-shell',
      updateOwner: 'organization',
      entrypoints: {
        desktopRoutes: ['components/gov-gui/routes.tsx'],
        themeTokens: ['components/gov-gui/tokens.css'],
      },
      permissions: [],
    };

    expect(validateComponentManifest(manifest)).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it('rejects organization components that claim kernel-owned paths', () => {
    const result = validateComponentManifest({
      manifestVersion: 1,
      id: 'gov.local.core-patch',
      displayName: 'Core Patch',
      version: '1.0.0',
      kind: 'tool',
      updateOwner: 'organization',
      entrypoints: {
        tools: ['packages/core/src/core/turn.ts'],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('must not own kernel paths');
  });

  it('allows kernel-owned manifests to describe kernel update entrypoints', () => {
    const result = validateComponentManifest({
      manifestVersion: 1,
      id: 'otto.kernel',
      displayName: 'Otto Kernel',
      version: '2.0.0',
      kind: 'runtime',
      updateOwner: 'kernel',
      entrypoints: {
        runtimeBins: ['packages/core/src/core/turn.ts'],
      },
      permissions: ['model:invoke'],
    });

    expect(result.ok).toBe(true);
  });

  it('identifies kernel-owned paths with normalized separators', () => {
    expect(isKernelOwnedPath('packages/core/src/core/subAgent.ts')).toBe(true);
    expect(isKernelOwnedPath('packages\\core\\src\\policy\\centralPolicy.ts')).toBe(true);
    expect(isKernelOwnedPath('components/custom/tool.ts')).toBe(false);
  });
});
