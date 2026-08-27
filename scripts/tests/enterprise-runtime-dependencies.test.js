import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectEnterpriseRuntimeDependencies,
  copyEnterpriseRuntimeDependencies,
} from '../enterprise-runtime-dependencies.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const temporaryRoots = [];
const lockedRuntimeDependencies = collectEnterpriseRuntimeDependencies({
  repoRoot,
});
const lockedInstallMaterialized = lockedRuntimeDependencies.dependencies.every(
  ({ location }) => existsSync(path.join(repoRoot, ...location.split('/'))),
);

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('enterprise runtime dependency closure', () => {
  it('collects the locked server production graph without development packages', () => {
    const result = collectEnterpriseRuntimeDependencies({ repoRoot });

    expect(result.directVersions).toMatchObject({
      '@aws-sdk/client-s3': '3.1100.0',
      '@aws-sdk/s3-request-presigner': '3.1100.0',
      '@google/genai': '1.35.0',
      pg: '8.22.0',
      redis: '4.7.1',
    });
    expect(result.directVersions).not.toHaveProperty('better-sqlite3');
    expect(result.directVersions).not.toHaveProperty('otto-core');

    const names = new Set(result.dependencies.map(({ name }) => name));
    expect(names).toContain('@aws-sdk/client-s3');
    expect(names).toContain('@smithy/core');
    expect(names).toContain('@larksuiteoapi/node-sdk');
    expect(names).toContain('ws');
    expect(names).not.toContain('typescript');
    expect(names).not.toContain('vitest');

    for (const dependency of result.dependencies) {
      expect(dependency.target).toMatch(/^node_modules\//u);
      expect(dependency.target).not.toContain('..');
      expect(dependency.version).toMatch(/^\d/u);
    }
  });

  it.skipIf(!lockedInstallMaterialized)(
    'copies the locked dependency closure into a standalone release root',
    () => {
      const temporaryRoot = mkdtempSync(
        path.join(os.tmpdir(), 'otto-enterprise-runtime-deps-'),
      );
      temporaryRoots.push(temporaryRoot);
      const releaseRoot = path.join(temporaryRoot, 'release');

      const result = copyEnterpriseRuntimeDependencies({
        repoRoot,
        releaseRoot,
      });

      expect(result.dependencies.length).toBeGreaterThan(100);
      for (const directName of Object.keys(result.directVersions)) {
        expect(
          existsSync(
            path.join(
              releaseRoot,
              'node_modules',
              ...directName.split('/'),
            ),
          ),
        ).toBe(true);
      }
      expect(
        existsSync(path.join(releaseRoot, 'node_modules', 'typescript')),
      ).toBe(false);
    },
  );
});
