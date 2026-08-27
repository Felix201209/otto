import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateServerIntegrationBaseline } from '../validate-server-integration-baseline.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const workflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);

describe('V1.9.13 enterprise candidate source identity', () => {
  it('pins the reviewed V1.9.13 source instead of a moving development branch', () => {
    expect(workflow).toContain(
      'REVIEWED_RELEASE_SOURCE: 82b5e0c101a44358efbb900b0c2be62455c2412b',
    );
    expect(workflow).not.toContain('origin/internal');
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$REVIEWED_RELEASE_SOURCE" "$GITHUB_SHA"',
    );
  });

  it('keeps server product source pinned and content-pins the packaging hotfix', () => {
    expect(workflow).toContain(
      'git diff --quiet "$REVIEWED_RELEASE_SOURCE" "$GITHUB_SHA"',
    );
    expect(workflow).toContain('packages/server');
    expect(workflow).toContain('deployment/enterprise-oneclick');
    expect(workflow).toContain('scripts/build-enterprise-oneclick.mjs');
    expect(workflow).toContain(
      'ENTERPRISE_PACKAGE_BUILDER_SHA256: c52158ef3025b0bd6d6cdd1dab429111d0c781411f1448647c74238d19f0515c',
    );
    expect(workflow).toContain(
      'ENTERPRISE_RUNTIME_DEPS_SHA256: 6218482a35cc049147020b0d7ef3933fac9a147c44aab0905b26629573d64569',
    );
    expect(workflow).toContain(
      'sha256sum scripts/build-enterprise-oneclick.mjs',
    );
    expect(workflow).toContain(
      'sha256sum scripts/enterprise-runtime-dependencies.mjs',
    );
    expect(workflow).toContain(
      'ENTERPRISE_UPGRADER_SHA256: 561432a5504a3bc506ea94b9b32d468989fa4de4a50f3f0d022b9fb2e0ea0482',
    );
    expect(workflow).toContain(
      'ENTERPRISE_RELEASE_VERIFIER_SHA256: 514c385c6b492a2e974f49e31b09ec2fd9c8fb7996f91431744cf3a9be7560dc',
    );
    expect(workflow).toContain(
      'sha256sum deployment/enterprise-oneclick/upgrade.sh',
    );
    expect(workflow).toContain(
      'sha256sum deployment/enterprise-oneclick/tools/verify-release.mjs',
    );
    expect(workflow).toContain(
      'SQLCIPHER_NATIVE_WORKFLOW_SHA256: 25f70e506ab855f2a3f5cde357e3a01ab95118c1675c78e9073b9053ac846d8a',
    );
    expect(workflow).toContain(
      'sha256sum .github/workflows/sqlcipher-native.yml',
    );
    expect(workflow).toContain(
      'unexpected change beyond reviewed V1.9.13 source',
    );
  });

  it('pins the npm resolver used with Node 22 so npm ci honors the reviewed lock', () => {
    expect(workflow).toContain("NPM_VERSION: '11.13.0'");
    expect(workflow).toContain(
      'npm install --global "npm@${NPM_VERSION}" --ignore-scripts',
    );
    expect(workflow).toContain('test "$(npm --version)" = "$NPM_VERSION"');
    expect(workflow).toContain('run: npm ci');
    expect(workflow).not.toContain('npm install --package-lock-only');
  });

  it('builds the referenced core declarations before server typechecking', () => {
    const coreBuildIndex = workflow.indexOf(
      'npm run build --workspace=packages/core',
    );
    const serverTypecheckIndex = workflow.indexOf(
      'npm run typecheck --workspace=packages/server',
    );

    expect(coreBuildIndex).toBeGreaterThan(-1);
    expect(serverTypecheckIndex).toBeGreaterThan(coreBuildIndex);
  });

  it('retains the repository integration ledger checks in hardened backfill mode', () => {
    expect(validateServerIntegrationBaseline({ rootDir: repoRoot })).toEqual(
      [],
    );
  });
});
