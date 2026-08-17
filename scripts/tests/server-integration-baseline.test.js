/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateServerIntegrationBaseline } from '../validate-server-integration-baseline.mjs';
import { supportedEnterpriseSchemaVersions } from '../enterprise-release-contract.mjs';

const rootDir = path.resolve('.');
const ledger = JSON.parse(
  readFileSync(
    path.join(rootDir, 'docs/server-integration-baseline.json'),
    'utf8',
  ),
);
const currentClientVersion = JSON.parse(
  readFileSync(
    path.join(rootDir, 'packages/desktop/package.json'),
    'utf8',
  ),
).version;
const fetchedInternalTip = execFileSync(
  'git',
  ['rev-parse', '--verify', 'origin/internal'],
  { cwd: rootDir, encoding: 'utf8' },
).trim();
const remoteBranchTips = new Map([['origin/internal', fetchedInternalTip]]);

describe('server integration baseline', () => {
  it('keeps the ledger aligned with versions, schema, capabilities and release policy', () => {
    expect(validateServerIntegrationBaseline({ rootDir })).toEqual([]);
    expect(supportedEnterpriseSchemaVersions(22)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22,
    ]);
  });

  it('fails when the client version drifts from the ledger', () => {
    const changed = structuredClone(ledger);
    changed.release.clientVersion = '99.0.0';

    expect(
      validateServerIntegrationBaseline({ rootDir, ledger: changed }),
    ).toContain(
      `release.clientVersion=99.0.0 does not match packages/desktop/package.json=${currentClientVersion}`,
    );
  });

  it('fails when an integrated source has no valid disposition or integration evidence', () => {
    const changed = structuredClone(ledger);
    changed.authority.integratedSources[0].disposition = 'publish-directly';
    changed.authority.integratedSources[0].integrationCommits = [];

    const errors = validateServerIntegrationBaseline({
      rootDir,
      ledger: changed,
    });
    expect(errors).toContain(
      `integrated source ${changed.authority.integratedSources[0].name} has invalid disposition publish-directly`,
    );
    expect(errors).toContain(
      `integrated source ${changed.authority.integratedSources[0].name} must name at least one integration commit`,
    );
  });

  it('fails when the recorded migration range drifts from the enterprise schema', () => {
    const changed = structuredClone(ledger);
    changed.release.databaseMigration.schemaTo = 21;

    expect(
      validateServerIntegrationBaseline({ rootDir, ledger: changed }),
    ).toContain(
      'release.databaseMigration.schemaTo=21 does not match enterprise schema=22',
    );
  });

  it('allows the catalogued integration point to remain an ancestor as internal advances', () => {
    const changed = structuredClone(ledger);
    changed.authority.baselineCommit =
      'f5ba898a60166bfde9c2cd74d8f3c8ec5f86a65e';

    expect(
      validateServerIntegrationBaseline({
        rootDir,
        ledger: changed,
        verifyGitRefs: true,
        remoteBranchTips,
      }),
    ).toEqual([]);
  });

  it('fails when an integration commit is absent from the release candidate', () => {
    const changed = structuredClone(ledger);
    changed.authority.integratedSources[0].integrationCommits = [
      'f'.repeat(40),
    ];

    expect(
      validateServerIntegrationBaseline({
        rootDir,
        ledger: changed,
        verifyGitRefs: true,
        remoteBranchTips,
        candidateHead: 'HEAD',
      }),
    ).toContain(
      `integration commit ${'f'.repeat(40)} for ${changed.authority.integratedSources[0].name} is not an ancestor of candidate HEAD`,
    );
  });

  it('fails when the candidate does not contain the authoritative internal baseline', () => {
    const candidate = ledger.authority.integratedSources[0].tip;

    expect(
      validateServerIntegrationBaseline({
        rootDir,
        verifyGitRefs: true,
        remoteBranchTips,
        candidateHead: candidate,
      }),
    ).toContain(
      `candidate ${candidate} does not contain authority baseline ${ledger.authority.baselineCommit}`,
    );
    expect(
      validateServerIntegrationBaseline({
        rootDir,
        verifyGitRefs: true,
        remoteBranchTips,
        candidateHead: candidate,
      }),
    ).toContain(
      `candidate ${candidate} does not contain latest origin/internal ${fetchedInternalTip}`,
    );
  });

  it('fails when the release workflow no longer enforces reviewed descendants of internal', () => {
    expect(
      validateServerIntegrationBaseline({
        rootDir,
        releaseWorkflow: 'name: unsafe release',
      }),
    ).toContain(
      'release workflow must require latest origin/internal as an ancestor and restrict additional commits to release refs',
    );
  });
});
