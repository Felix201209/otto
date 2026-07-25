/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseIncrementalUpdateManifest } from './incremental-update-manifest.js';

const sha = 'a'.repeat(64);

describe('incremental update manifest', () => {
  it('accepts patch, kernel and component channels with signed https artifacts', () => {
    const parsed = parseIncrementalUpdateManifest({
      schemaVersion: 1,
      appVersion: '1.9.5',
      sourceCommit: 'f09c18d28e5359d15328c0f6a13fb7c2ea1d523a',
      publishedAt: '2026-07-25T00:00:00.000Z',
      channels: {
        patch: [{
          id: 'patch-login-lease-v1',
          kind: 'patch',
          version: '1.9.5+patch.1',
          target: 'desktop/main',
          compat: { appVersion: '1.9.5', sourceCommit: 'f09c18d28e5359d15328c0f6a13fb7c2ea1d523a' },
          url: 'https://updates.example.com/otto/patch-login-lease-v1.tar.zst',
          size: 4096,
          sha256: sha,
          signature: 'ed25519:example',
          restart: 'app',
          rollback: { supported: true, receipt: true },
        }],
        kernel: [{
          id: 'kernel-core-abi-2026-07',
          kind: 'kernel',
          version: '1.9.5+k1',
          target: 'core/server/native',
          compat: { appVersion: '1.9.5', kernelAbi: '2026.07' },
          url: 'https://updates.example.com/otto/kernel-core-abi-2026-07.tar.zst',
          size: 8192,
          sha256: sha,
          signature: 'ed25519:example',
          restart: 'server',
          rollback: { supported: true, receipt: true },
        }],
        component: [{
          id: 'component-skills-ppt-v2',
          kind: 'component',
          version: '2026.07.25',
          target: 'skills/presentations',
          compat: { appVersion: '1.9.5', componentApi: 'skills.v1' },
          url: 'https://updates.example.com/otto/component-skills-ppt-v2.tar.zst',
          size: 2048,
          sha256: sha,
          signature: 'ed25519:example',
          restart: 'none',
          rollback: { supported: true, receipt: true },
        }],
      },
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.channels.patch[0].target).toBe('desktop/main');
      expect(parsed.manifest.channels.kernel[0].restart).toBe('server');
      expect(parsed.manifest.channels.component[0].restart).toBe('none');
    }
  });

  it('rejects unsigned artifacts before download', () => {
    const parsed = parseIncrementalUpdateManifest({
      schemaVersion: 1,
      appVersion: '1.9.5',
      sourceCommit: 'abc',
      publishedAt: '2026-07-25T00:00:00.000Z',
      channels: {
        patch: [{
          id: 'bad',
          kind: 'patch',
          version: '1.9.5+patch.1',
          target: 'desktop/main',
          compat: { appVersion: '1.9.5' },
          url: 'https://updates.example.com/bad.tar.zst',
          size: 1,
          sha256: sha,
          signature: '',
          restart: 'app',
          rollback: { supported: true, receipt: true },
        }],
        kernel: [],
        component: [],
      },
    });

    expect(parsed).toEqual({ ok: false, error: 'patch artifact missing signature' });
  });

  it('rejects non-https artifacts', () => {
    const parsed = parseIncrementalUpdateManifest({
      schemaVersion: 1,
      appVersion: '1.9.5',
      sourceCommit: 'abc',
      publishedAt: '2026-07-25T00:00:00.000Z',
      channels: {
        patch: [{
          id: 'bad',
          kind: 'patch',
          version: '1.9.5+patch.1',
          target: 'desktop/main',
          compat: { appVersion: '1.9.5' },
          url: 'http://updates.example.com/bad.tar.zst',
          size: 1,
          sha256: sha,
          signature: 'ed25519:example',
          restart: 'app',
          rollback: { supported: true, receipt: true },
        }],
        kernel: [],
        component: [],
      },
    });

    expect(parsed).toEqual({ ok: false, error: 'patch artifact url must use https' });
  });
});
