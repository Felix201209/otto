import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const workflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'deploy-server.yml'),
  'utf8',
);

describe('enterprise production deployment workflow', () => {
  it('defaults to dry-run and requires an exact confirmation before apply', () => {
    expect(workflow).toContain('default: true');
    expect(workflow).toContain('apply_confirmation:');
    expect(workflow).toContain('DEPLOY_V1.9.13');
    expect(workflow).toContain(
      'refusing production apply without exact confirmation',
    );
  });

  it('requires a successful protected backup before the production upgrade', () => {
    const backup = workflow.indexOf('backup-now.sh');
    const upgrade = workflow.indexOf('upgrade.sh');
    expect(backup).toBeGreaterThan(-1);
    expect(upgrade).toBeGreaterThan(backup);
  });

  it('accepts only the reviewed V1.9.13 package in this deployment branch', () => {
    expect(workflow).toContain('test "$TAG" = \'1.9.13\'');
  });
});
