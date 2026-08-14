/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

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
const remoteBranchTips = new Map([
  ['origin/internal', 'c45c181bfed507d645b17169ec7253c59fbf1d19'],
  ...ledger.branches.map((branch) => [branch.name, branch.tip]),
]);

describe('server integration baseline', () => {
  it('keeps the checked-in ledger aligned with product versions, schema and release policy', () => {
    expect(validateServerIntegrationBaseline({ rootDir })).toEqual([]);
    expect(supportedEnterpriseSchemaVersions(18)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    ]);
  });

  it('fails when the client or server product version drifts from the ledger', () => {
    const changed = structuredClone(ledger);
    changed.release.clientVersion = '99.0.0';

    expect(
      validateServerIntegrationBaseline({ rootDir, ledger: changed }),
    ).toContain(
      'release.clientVersion=99.0.0 does not match packages/desktop/package.json=1.10.0',
    );
  });

  it('fails when a branch commit has no explicit integrate, rewrite or drop decision', () => {
    const changed = structuredClone(ledger);
    changed.branches[0].uniqueCommits.push('f'.repeat(40));

    expect(
      validateServerIntegrationBaseline({ rootDir, ledger: changed }),
    ).toContain(
      `branch ${changed.branches[0].name} references unclassified commit ${'f'.repeat(40)}`,
    );
  });

  it('fails when the recorded migration range drifts from the enterprise schema', () => {
    const changed = structuredClone(ledger);
    changed.release.databaseMigration.schemaTo = 17;

    expect(
      validateServerIntegrationBaseline({ rootDir, ledger: changed }),
    ).toContain(
      'release.databaseMigration.schemaTo=17 does not match enterprise schema=18',
    );
  });

  it('fails when a fetched experimental branch moves beyond the audited ledger', () => {
    const changed = structuredClone(ledger);
    changed.branches[0].tip = 'f'.repeat(40);

    expect(
      validateServerIntegrationBaseline({
        rootDir,
        ledger: changed,
        verifyGitRefs: true,
        remoteBranchTips,
      }),
    ).toContain(
      `branch ${changed.branches[0].name} tip ${'f'.repeat(40)} does not match fetched ref e9440c14725224eac0209bbcb8238006b50a2a2b`,
    );
  });

  it('fails when local remote-tracking refs are stale compared with live origin', () => {
    const changedRemoteTips = new Map(remoteBranchTips);
    changedRemoteTips.set(ledger.branches[0].name, 'f'.repeat(40));

    expect(
      validateServerIntegrationBaseline({
        rootDir,
        verifyGitRefs: true,
        remoteBranchTips: changedRemoteTips,
      }),
    ).toContain(
      `fetched ${ledger.branches[0].name} tip ${ledger.branches[0].tip} does not match live origin ${'f'.repeat(40)}`,
    );
  });

  it('fails when an audited branch was deleted from live origin', () => {
    const changedRemoteTips = new Map(remoteBranchTips);
    changedRemoteTips.delete(ledger.branches[0].name);

    expect(
      validateServerIntegrationBaseline({
        rootDir,
        verifyGitRefs: true,
        remoteBranchTips: changedRemoteTips,
      }),
    ).toContain(`required live branch is missing: ${ledger.branches[0].name}`);
  });

  it('fails when a catalogued commit subject drifts from git history', () => {
    const changed = structuredClone(ledger);
    changed.commitDecisions[0].subject = 'invented subject';

    expect(
      validateServerIntegrationBaseline({
        rootDir,
        ledger: changed,
        verifyGitRefs: true,
        remoteBranchTips,
      }),
    ).toContain(
      `commit ${changed.commitDecisions[0].commit} subject "invented subject" does not match git "feat(server): add SQLCipher database encryption"`,
    );
  });

  it('fails when the release workflow no longer requires the latest internal commit', () => {
    expect(
      validateServerIntegrationBaseline({
        rootDir,
        releaseWorkflow: 'name: unsafe release',
      }),
    ).toContain(
      'release workflow must compare HEAD with the latest origin/internal commit',
    );
  });
});
