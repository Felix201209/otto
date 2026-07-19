/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const COMMON_SH = path.resolve('deployment/enterprise-oneclick/lib/common.sh');
const INSTALL_SH = path.resolve('deployment/enterprise-oneclick/install.sh');

function mode(target) {
  return statSync(target).mode & 0o777;
}

describe('enterprise one-click service layout', () => {
  it('makes the root-owned runtime and release traversable by the systemd user', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'otto-oneclick-layout-'));
    try {
      const installRoot = path.join(sandbox, 'opt', 'otto-enterprise');
      const runtime = path.join(installRoot, 'runtime');
      const nodeBin = path.join(runtime, 'node-v22', 'bin', 'node');
      const releases = path.join(installRoot, 'releases');
      const release = path.join(releases, 'v1.8.8-test');
      const serverEntry = path.join(release, 'src', 'enterprise', 'bin.js');

      mkdirSync(path.dirname(nodeBin), { recursive: true, mode: 0o700 });
      mkdirSync(path.dirname(serverEntry), { recursive: true, mode: 0o700 });
      writeFileSync(nodeBin, '#!/bin/sh\n', { mode: 0o700 });
      writeFileSync(serverEntry, 'export {};\n', { mode: 0o600 });
      for (const target of [
        installRoot,
        runtime,
        path.join(runtime, 'node-v22'),
        path.dirname(nodeBin),
        releases,
        release,
        path.join(release, 'src'),
        path.dirname(serverEntry),
      ]) {
        chmodSync(target, 0o700);
      }

      const result = spawnSync(
        '/bin/bash',
        [
          '-c',
          'source "$1"; shift; otto_prepare_service_layout "$@"',
          'bash',
          COMMON_SH,
          installRoot,
          release,
        ],
        { encoding: 'utf8' },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(mode(installRoot)).toBe(0o755);
      expect(mode(runtime)).toBe(0o755);
      expect(mode(path.join(runtime, 'node-v22', 'bin'))).toBe(0o755);
      expect(mode(nodeBin)).toBe(0o755);
      expect(mode(releases)).toBe(0o755);
      expect(mode(path.dirname(serverEntry))).toBe(0o755);
      expect(mode(serverEntry)).toBe(0o644);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('applies the service layout before systemd starts Otto', () => {
    const installer = readFileSync(INSTALL_SH, 'utf8');
    const hardening = installer.indexOf(
      'otto_prepare_service_layout "$INSTALL_ROOT" "$TARGET_RELEASE"',
    );
    const serviceStart = installer.indexOf('systemctl enable --now otto-enterprise');
    expect(hardening).toBeGreaterThan(-1);
    expect(serviceStart).toBeGreaterThan(hardening);
  });
});
