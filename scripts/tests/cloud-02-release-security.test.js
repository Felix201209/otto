/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(
  path.resolve('.github/workflows/release.yml'),
  'utf8',
);
const deployWorkflow = readFileSync(
  path.resolve('.github/workflows/deploy-server.yml'),
  'utf8',
);
const builder = readFileSync(
  path.resolve('scripts/build-enterprise-oneclick.mjs'),
  'utf8',
);

describe('CLOUD-02 release security boundary', () => {
  it('keeps the enterprise private key out of the package build step', () => {
    const buildBlock = releaseWorkflow.slice(
      releaseWorkflow.indexOf('- name: Build enterprise server package'),
      releaseWorkflow.indexOf(
        '- name: Sign enterprise package and cloud artifact index',
      ),
    );
    expect(buildBlock).toContain('OTTO_DEFER_ENTERPRISE_SIGNING');
    expect(buildBlock).not.toContain('OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY:');
    expect(builder).toContain(
      'delete childEnvironment.OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY;',
    );
    expect(builder).toContain(
      'delete childEnvironment.OTTO_ENTERPRISE_SIGNING_PRIVATE_KEY_FILE;',
    );
  });

  it('publishes and verifies the signed immutable artifact index', () => {
    expect(releaseWorkflow).toContain('npm run sign:aliyun:server');
    expect(releaseWorkflow).toContain(
      'otto-aliyun-server-artifact-v${VERSION}-*.json',
    );
    expect(releaseWorkflow).toContain(
      'node scripts/verify-aliyun-server-artifact.mjs',
    );
    expect(releaseWorkflow).toContain('--architecture linux-x64');
    expect(releaseWorkflow).toContain('--architecture linux-arm64');
  });

  it.each([
    ['release deployment', releaseWorkflow],
    ['standalone deployment', deployWorkflow],
  ])(
    'verifies %s on the target before extracting or executing it',
    (_name, workflow) => {
      const remoteVerification = workflow.indexOf(
        'node ./verify-aliyun-server-artifact.mjs',
      );
      const extraction = workflow.indexOf('tar -xzf');
      expect(remoteVerification).toBeGreaterThan(0);
      expect(extraction).toBeGreaterThan(remoteVerification);
      expect(workflow).toContain('--minimum-release-sequence');
      expect(workflow).toContain('/var/lib/otto-enterprise/release-sequence');
    },
  );

  it('bundles the production dependency closure instead of a SQLite-only runtime', () => {
    expect(builder).toContain('bundleRuntimeDependencyClosure');
    expect(builder).toContain('serverPackage.dependencies');
    expect(builder).toContain("name !== 'better-sqlite3'");
    expect(builder).toContain("name !== 'otto-core'");
  });
});
