#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { supportedEnterpriseSchemaVersions } from './enterprise-release-contract.mjs';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DECISIONS = new Set(['integrate', 'rewrite', 'drop']);
const SOURCE_DISPOSITIONS = new Set(['integrated', 'rewritten', 'retired']);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function parseEnterpriseContract(rootDir) {
  const serverSource = readFileSync(
    path.join(rootDir, 'packages/server/src/enterprise/server.ts'),
    'utf8',
  );
  const databaseSource = readFileSync(
    path.join(rootDir, 'packages/server/src/enterprise/db.ts'),
    'utf8',
  );
  const productModulesSource = readFileSync(
    path.join(rootDir, 'packages/server/src/productModules.ts'),
    'utf8',
  );

  const apiVersion = Number(
    /const ENTERPRISE_API_VERSION\s*=\s*(\d+)/u.exec(serverSource)?.[1],
  );
  const schemaVersion = Number(
    /export const ENTERPRISE_SCHEMA_VERSION\s*=\s*(\d+)/u.exec(
      databaseSource,
    )?.[1],
  );
  const capabilityBlock =
    /const ENTERPRISE_CAPABILITIES\s*=\s*\[([\s\S]*?)\]\s*as const/u.exec(
      serverSource,
    )?.[1] ?? '';
  const capabilities = [...capabilityBlock.matchAll(/'([^']+)'/gu)].map(
    (match) => match[1],
  );
  const productModuleBlock =
    /export const PRODUCT_MODULES\s*=\s*\[([\s\S]*?)\]\s*as const/u.exec(
      productModulesSource,
    )?.[1] ?? '';
  const productModules = [
    ...productModuleBlock.matchAll(/^\s{4}id:\s*'([^']+)'/gmu),
  ].map((match) => match[1]);

  return { apiVersion, schemaVersion, capabilities, productModules };
}

function sameOrderedValues(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function queryRemoteBranchTips(rootDir, branchNames) {
  const refs = [
    'refs/heads/internal',
    ...branchNames.map(
      (branch) => `refs/heads/${branch.replace(/^origin\//u, '')}`,
    ),
  ];
  const output = execFileSync(
    'git',
    ['ls-remote', '--heads', 'origin', ...refs],
    {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return new Map(
    output
      .trim()
      .split(/\n/u)
      .filter(Boolean)
      .map((line) => {
        const [commit, ref] = line.split(/\s+/u);
        return [
          ref === 'refs/heads/internal'
            ? 'origin/internal'
            : `origin/${ref.slice('refs/heads/'.length)}`,
          commit,
        ];
      }),
  );
}

export function validateServerIntegrationBaseline({
  rootDir = process.cwd(),
  ledger,
  releaseWorkflow,
  ciWorkflow,
  verifyGitRefs = false,
  remoteBranchTips,
  candidateHead: candidateHeadOverride,
} = {}) {
  const errors = [];
  const actualLedger =
    ledger ??
    readJson(path.join(rootDir, 'docs/server-integration-baseline.json'));
  const rootPackage = readJson(path.join(rootDir, 'package.json'));
  const desktopPackage = readJson(
    path.join(rootDir, 'packages/desktop/package.json'),
  );
  const serverPackage = readJson(
    path.join(rootDir, 'packages/server/package.json'),
  );
  const enterprise = parseEnterpriseContract(rootDir);
  const workflow =
    releaseWorkflow ??
    readFileSync(path.join(rootDir, '.github/workflows/release.yml'), 'utf8');
  const continuousIntegrationWorkflow =
    ciWorkflow ??
    readFileSync(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8');

  if (actualLedger.schemaVersion !== 2) {
    errors.push('ledger schemaVersion must be 2');
  }
  if (actualLedger.authority?.branch !== 'internal') {
    errors.push('authority.branch must be internal');
  }
  if (!COMMIT_PATTERN.test(actualLedger.authority?.baselineCommit ?? '')) {
    errors.push('authority.baselineCommit must be a full 40-character commit');
  }
  const integratedSourceNames = new Set();
  for (const source of actualLedger.authority?.integratedSources ?? []) {
    if (!source.name || integratedSourceNames.has(source.name)) {
      errors.push(
        `duplicate or missing integrated source name: ${source.name ?? '<missing>'}`,
      );
      continue;
    }
    integratedSourceNames.add(source.name);
    if (!COMMIT_PATTERN.test(source.tip ?? '')) {
      errors.push(
        `integrated source ${source.name} must record a full tip commit`,
      );
    }
    if (!SOURCE_DISPOSITIONS.has(source.disposition)) {
      errors.push(
        `integrated source ${source.name} has invalid disposition ${source.disposition ?? '<missing>'}`,
      );
    }
    if (!source.reason?.trim()) {
      errors.push(`integrated source ${source.name} must include a reason`);
    }
    if (
      !Array.isArray(source.capabilities) ||
      source.capabilities.length === 0
    ) {
      errors.push(
        `integrated source ${source.name} must list its capabilities`,
      );
    }
    if (
      !Array.isArray(source.integrationCommits) ||
      source.integrationCommits.length === 0
    ) {
      errors.push(
        `integrated source ${source.name} must name at least one integration commit`,
      );
      continue;
    }
    for (const commit of source.integrationCommits) {
      if (!COMMIT_PATTERN.test(commit ?? '')) {
        errors.push(
          `integrated source ${source.name} has invalid integration commit ${commit ?? '<missing>'}`,
        );
      }
    }
  }
  for (const entry of actualLedger.authority?.recentIntegratedHistory ?? []) {
    if (!COMMIT_PATTERN.test(entry.commit ?? '')) {
      errors.push(
        'authority history commit must be a full 40-character commit',
      );
    }
    if (!COMMIT_PATTERN.test(entry.integrationCommit ?? '')) {
      errors.push(
        'authority history integrationCommit must be a full 40-character commit',
      );
    }
    if (entry.decision !== 'integrated' || !entry.reason?.trim()) {
      errors.push(
        'authority history entries must record an integrated decision and reason',
      );
    }
  }
  if (actualLedger.release?.serverVersion !== rootPackage.version) {
    errors.push(
      `release.serverVersion=${actualLedger.release?.serverVersion} does not match package.json=${rootPackage.version}`,
    );
  }
  if (actualLedger.release?.clientVersion !== desktopPackage.version) {
    errors.push(
      `release.clientVersion=${actualLedger.release?.clientVersion} does not match packages/desktop/package.json=${desktopPackage.version}`,
    );
  }
  if (actualLedger.release?.serverPackageVersion !== serverPackage.version) {
    errors.push(
      `release.serverPackageVersion=${actualLedger.release?.serverPackageVersion} does not match packages/server/package.json=${serverPackage.version}`,
    );
  }
  if (rootPackage.version !== desktopPackage.version) {
    errors.push(
      `product version drift: package.json=${rootPackage.version} desktop=${desktopPackage.version}`,
    );
  }
  if (actualLedger.release?.apiVersion !== enterprise.apiVersion) {
    errors.push(
      `release.apiVersion=${actualLedger.release?.apiVersion} does not match enterprise API=${enterprise.apiVersion}`,
    );
  }
  if (
    actualLedger.release?.enterpriseSchemaVersion !== enterprise.schemaVersion
  ) {
    errors.push(
      `release.enterpriseSchemaVersion=${actualLedger.release?.enterpriseSchemaVersion} does not match enterprise schema=${enterprise.schemaVersion}`,
    );
  }
  if (
    actualLedger.release?.databaseMigration?.schemaTo !==
    enterprise.schemaVersion
  ) {
    errors.push(
      `release.databaseMigration.schemaTo=${actualLedger.release?.databaseMigration?.schemaTo} does not match enterprise schema=${enterprise.schemaVersion}`,
    );
  }
  if (
    actualLedger.release?.databaseMigration?.source !==
    'scripts/enterprise-release-contract.mjs'
  ) {
    errors.push(
      'release.databaseMigration.source must reference the shared enterprise release contract',
    );
  }
  const supportedSchemaFrom = supportedEnterpriseSchemaVersions(
    enterprise.schemaVersion,
  );
  if (
    !sameOrderedValues(
      actualLedger.release?.databaseMigration?.supportedSchemaFrom,
      supportedSchemaFrom,
    )
  ) {
    errors.push(
      'release.databaseMigration.supportedSchemaFrom must match the enterprise release contract',
    );
  }
  if (
    !sameOrderedValues(
      actualLedger.release?.capabilities,
      enterprise.capabilities,
    )
  ) {
    errors.push('release.capabilities do not match ENTERPRISE_CAPABILITIES');
  }
  if (
    !sameOrderedValues(
      actualLedger.release?.productModules,
      enterprise.productModules,
    )
  ) {
    errors.push('release.productModules do not match PRODUCT_MODULES');
  }

  const decisions = new Map();
  for (const entry of actualLedger.commitDecisions ?? []) {
    if (!COMMIT_PATTERN.test(entry.commit ?? '')) {
      errors.push(
        `invalid commit decision SHA: ${entry.commit ?? '<missing>'}`,
      );
      continue;
    }
    if (decisions.has(entry.commit)) {
      errors.push(`duplicate commit decision: ${entry.commit}`);
      continue;
    }
    decisions.set(entry.commit, entry);
    if (!DECISIONS.has(entry.decision)) {
      errors.push(`invalid decision for ${entry.commit}: ${entry.decision}`);
    }
    if (!entry.reason?.trim()) {
      errors.push(`commit decision ${entry.commit} must include a reason`);
    }
    if (
      entry.decision === 'rewrite' &&
      !Number.isInteger(entry.followUpIssue)
    ) {
      errors.push(
        `rewrite decision ${entry.commit} must name a follow-up issue`,
      );
    }
    if (
      entry.decision === 'drop' &&
      !COMMIT_PATTERN.test(entry.replacementCommit ?? '')
    ) {
      errors.push(
        `drop decision ${entry.commit} must name a replacement commit`,
      );
    }
  }

  const referencedCommits = new Set();
  const branchNames = new Set();
  for (const branch of actualLedger.branches ?? []) {
    if (!branch.name || branchNames.has(branch.name)) {
      errors.push(
        `duplicate or missing branch name: ${branch.name ?? '<missing>'}`,
      );
      continue;
    }
    branchNames.add(branch.name);
    if (!COMMIT_PATTERN.test(branch.tip ?? '')) {
      errors.push(`branch ${branch.name} must record a full tip commit`);
    }
    for (const commit of branch.uniqueCommits ?? []) {
      referencedCommits.add(commit);
      const decision = decisions.get(commit);
      if (!decision || !decision.sourceBranches?.includes(branch.name)) {
        errors.push(
          `branch ${branch.name} references unclassified commit ${commit}`,
        );
      }
    }
    if (
      branch.status === 'integrated' &&
      (branch.uniqueCommits?.length ?? 0) !== 0
    ) {
      errors.push(
        `integrated branch ${branch.name} must have no unique commits`,
      );
    }
  }
  for (const [commit, decision] of decisions) {
    if (!referencedCommits.has(commit)) {
      errors.push(`commit decision ${commit} is not referenced by a branch`);
    }
    for (const branch of decision.sourceBranches ?? []) {
      if (!branchNames.has(branch)) {
        errors.push(
          `commit decision ${commit} references unknown branch ${branch}`,
        );
      }
    }
  }

  if (verifyGitRefs) {
    let liveBranchTips = remoteBranchTips;
    if (!liveBranchTips) {
      try {
        liveBranchTips = queryRemoteBranchTips(
          rootDir,
          (actualLedger.branches ?? []).map((branch) => branch.name),
        );
      } catch {
        liveBranchTips = new Map();
        errors.push('unable to query live origin branch tips');
      }
    }

    let fetchedInternalTip;
    try {
      fetchedInternalTip = execFileSync(
        'git',
        ['rev-parse', '--verify', 'origin/internal'],
        {
          cwd: rootDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ).trim();
    } catch {
      errors.push('required fetched branch is missing: origin/internal');
    }
    const liveInternalTip = liveBranchTips.get('origin/internal');
    if (!liveInternalTip) {
      errors.push('required live branch is missing: origin/internal');
    } else if (fetchedInternalTip && fetchedInternalTip !== liveInternalTip) {
      errors.push(
        `fetched origin/internal tip ${fetchedInternalTip} does not match live origin ${liveInternalTip}`,
      );
    }

    try {
      execFileSync(
        'git',
        [
          'merge-base',
          '--is-ancestor',
          actualLedger.authority.baselineCommit,
          'origin/internal',
        ],
        { cwd: rootDir, stdio: 'ignore' },
      );
    } catch {
      errors.push(
        `authority baseline ${actualLedger.authority.baselineCommit} is not an ancestor of origin/internal`,
      );
    }

    for (const entry of actualLedger.authority?.recentIntegratedHistory ?? []) {
      for (const commit of [entry.commit, entry.integrationCommit]) {
        try {
          execFileSync(
            'git',
            [
              'merge-base',
              '--is-ancestor',
              commit,
              actualLedger.authority.baselineCommit,
            ],
            { cwd: rootDir, stdio: 'ignore' },
          );
        } catch {
          errors.push(
            `authority history commit ${commit} is not integrated into baseline ${actualLedger.authority.baselineCommit}`,
          );
        }
      }
    }

    let candidateHead = candidateHeadOverride;
    if (!candidateHead) {
      try {
        candidateHead = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: rootDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        errors.push(
          'unable to resolve candidate HEAD for branch delta validation',
        );
        candidateHead = 'HEAD';
      }
    }

    try {
      execFileSync(
        'git',
        [
          'merge-base',
          '--is-ancestor',
          actualLedger.authority.baselineCommit,
          candidateHead,
        ],
        { cwd: rootDir, stdio: 'ignore' },
      );
    } catch {
      errors.push(
        `candidate ${candidateHead} does not contain authority baseline ${actualLedger.authority.baselineCommit}`,
      );
    }

    if (fetchedInternalTip) {
      try {
        execFileSync(
          'git',
          ['merge-base', '--is-ancestor', fetchedInternalTip, candidateHead],
          { cwd: rootDir, stdio: 'ignore' },
        );
      } catch {
        errors.push(
          `candidate ${candidateHead} does not contain latest origin/internal ${fetchedInternalTip}`,
        );
      }
    }

    for (const source of actualLedger.authority?.integratedSources ?? []) {
      for (const commit of source.integrationCommits ?? []) {
        if (!COMMIT_PATTERN.test(commit ?? '')) continue;
        try {
          execFileSync(
            'git',
            ['merge-base', '--is-ancestor', commit, candidateHead],
            { cwd: rootDir, stdio: 'ignore' },
          );
        } catch {
          errors.push(
            `integration commit ${commit} for ${source.name} is not an ancestor of candidate ${candidateHead}`,
          );
        }
      }
    }

    for (const branch of actualLedger.branches ?? []) {
      let fetchedTip;
      try {
        fetchedTip = execFileSync(
          'git',
          ['rev-parse', '--verify', branch.name],
          {
            cwd: rootDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        ).trim();
      } catch {
        errors.push(`required fetched branch is missing: ${branch.name}`);
        continue;
      }
      if (branch.tip !== fetchedTip) {
        errors.push(
          `branch ${branch.name} tip ${branch.tip} does not match fetched ref ${fetchedTip}`,
        );
      }
      const liveTip = liveBranchTips.get(branch.name);
      if (!liveTip) {
        errors.push(`required live branch is missing: ${branch.name}`);
      } else {
        if (fetchedTip !== liveTip) {
          errors.push(
            `fetched ${branch.name} tip ${fetchedTip} does not match live origin ${liveTip}`,
          );
        }
        if (branch.tip !== liveTip) {
          errors.push(
            `branch ${branch.name} tip ${branch.tip} does not match live origin ${liveTip}`,
          );
        }
      }
      const actualUnique = new Set(
        execFileSync(
          'git',
          [
            'rev-list',
            '--right-only',
            '--cherry-pick',
            `${candidateHead}...${branch.name}`,
          ],
          { cwd: rootDir, encoding: 'utf8' },
        )
          .trim()
          .split(/\s+/u)
          .filter(Boolean),
      );
      const recordedUnique = new Set(branch.uniqueCommits ?? []);
      for (const commit of actualUnique) {
        if (!recordedUnique.has(commit)) {
          errors.push(
            `branch ${branch.name} has unrecorded unique commit ${commit}`,
          );
        }
      }
      for (const commit of recordedUnique) {
        if (!actualUnique.has(commit)) {
          errors.push(
            `branch ${branch.name} no longer has recorded unique commit ${commit}`,
          );
        }
      }
    }

    for (const entry of actualLedger.commitDecisions ?? []) {
      let actualSubject;
      try {
        actualSubject = execFileSync(
          'git',
          ['show', '-s', '--format=%s', entry.commit],
          {
            cwd: rootDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        ).trim();
      } catch {
        errors.push(
          `catalogued commit is missing from git history: ${entry.commit}`,
        );
        continue;
      }
      if (entry.subject !== actualSubject) {
        errors.push(
          `commit ${entry.commit} subject ${JSON.stringify(entry.subject)} does not match git ${JSON.stringify(actualSubject)}`,
        );
      }
      if (entry.decision === 'drop') {
        try {
          execFileSync(
            'git',
            [
              'merge-base',
              '--is-ancestor',
              entry.replacementCommit,
              actualLedger.authority.baselineCommit,
            ],
            { cwd: rootDir, stdio: 'ignore' },
          );
        } catch {
          errors.push(
            `drop replacement ${entry.replacementCommit} is not integrated into baseline ${actualLedger.authority.baselineCommit}`,
          );
        }
      }
    }
  }

  for (const acceptance of actualLedger.acceptance ?? []) {
    if (
      acceptance.status === 'verified' &&
      (!Array.isArray(acceptance.evidence) || acceptance.evidence.length === 0)
    ) {
      errors.push(`verified acceptance ${acceptance.id} must include evidence`);
    }
  }

  const hasInternalFetch = /git fetch --no-tags origin internal/u.test(
    workflow,
  );
  const hasSourceRead = /SOURCE_COMMIT="\$\(git rev-parse HEAD\)"/u.test(
    workflow,
  );
  const hasInternalRead =
    /INTERNAL_COMMIT="\$\(git rev-parse origin\/internal\)"/u.test(workflow);
  const hasAncestorCheck =
    /git merge-base --is-ancestor "\$INTERNAL_COMMIT" "\$SOURCE_COMMIT"/u.test(
      workflow,
    );
  const restrictsReleaseBranches = workflow.includes('refs/heads/release/*');
  const restrictsVersionTags = workflow.includes('refs/tags/v*');
  const hasStandardReleasePolicy =
    hasInternalFetch &&
    hasSourceRead &&
    hasInternalRead &&
    hasAncestorCheck &&
    restrictsReleaseBranches &&
    restrictsVersionTags;
  const reviewedBackfillSource =
    /^\s*REVIEWED_RELEASE_SOURCE:\s*([0-9a-f]{40})\s*$/mu.exec(workflow)?.[1];
  const hasHardenedBackfillPolicy = Boolean(
    reviewedBackfillSource &&
    workflow.includes('name: Enterprise Server Candidate') &&
    workflow.includes('test "${{ inputs.version }}" = \'1.9.13\'') &&
    workflow.includes(
      'git merge-base --is-ancestor "$REVIEWED_RELEASE_SOURCE" "$GITHUB_SHA"',
    ) &&
    workflow.includes(
      'git diff --quiet "$REVIEWED_RELEASE_SOURCE" "$GITHUB_SHA"',
    ) &&
    workflow.includes('unexpected change beyond reviewed V1.9.13 source') &&
    /permissions:\s*\n\s*contents:\s*read/u.test(workflow) &&
    !/permissions:\s*\n\s*contents:\s*write/u.test(workflow) &&
    !/^\s*push:\s*$/mu.test(workflow) &&
    !/^\s*release:\s*$/mu.test(workflow) &&
    !workflow.includes('gh release') &&
    workflow.includes('OTTO_ALLOW_UNSIGNED_ENTERPRISE_PACKAGE') &&
    workflow.includes('test ! -e "$signature"') &&
    workflow.includes('Upload candidate for isolated signing'),
  );
  if (!hasStandardReleasePolicy && !hasHardenedBackfillPolicy) {
    errors.push(
      'release workflow must require latest origin/internal as an ancestor and restrict additional commits to release refs',
    );
  }
  const validationCommand = 'npm run validate:integration-baseline';
  const gitRefValidationCommand = `${validationCommand} -- --verify-git-refs`;
  if (
    rootPackage.scripts?.['validate:integration-baseline'] !==
    'node scripts/validate-server-integration-baseline.mjs'
  ) {
    errors.push('package.json must expose validate:integration-baseline');
  }
  if (!continuousIntegrationWorkflow.includes(gitRefValidationCommand)) {
    errors.push(
      'CI must run validate:integration-baseline with fetched git refs',
    );
  }
  for (const branch of actualLedger.branches ?? []) {
    if (!continuousIntegrationWorkflow.includes(branch.name)) {
      errors.push(`CI must fetch audited branch ${branch.name}`);
    }
  }
  if (!workflow.includes(validationCommand)) {
    errors.push('release workflow must run validate:integration-baseline');
  }

  return errors;
}

function runCli() {
  const verifyGitRefs = process.argv.includes('--verify-git-refs');
  const errors = validateServerIntegrationBaseline({ verifyGitRefs });
  if (errors.length > 0) {
    for (const error of errors)
      process.stderr.write(`[integration-baseline] ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, ledger: 'docs/server-integration-baseline.json', gitRefsVerified: verifyGitRefs })}\n`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  runCli();
}
