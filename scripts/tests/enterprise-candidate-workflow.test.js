import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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

  it('requires zero enterprise product-source differences from that release', () => {
    expect(workflow).toContain(
      'git diff --quiet "$REVIEWED_RELEASE_SOURCE" "$GITHUB_SHA"',
    );
    expect(workflow).toContain('packages/server');
    expect(workflow).toContain('deployment/enterprise-oneclick');
    expect(workflow).toContain('scripts/build-enterprise-oneclick.mjs');
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
});
