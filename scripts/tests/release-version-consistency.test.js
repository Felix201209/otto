/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(path.resolve('package.json'), 'utf8'),
);
const version = packageJson.version;

const versionDisplays = [
  {
    path: 'packages/desktop/preview/live-bridge.ts',
    expected: [
      `Promise.resolve('${version}-browser')`,
      `currentVersion: '${version}'`,
    ],
  },
  {
    path: 'packages/desktop/src/renderer/browserPreviewBridge.ts',
    expected: [
      `Promise.resolve('${version}-browser-preview')`,
      `currentVersion: '${version}'`,
    ],
  },
  {
    path: 'packages/server/src/server.ts',
    expected: [
      `appVersion: () => Promise.resolve('${version}')`,
      `currentVersion: '${version}'`,
    ],
  },
  {
    path: 'packages/server/src/enterprise/bin.ts',
    expected: [`OTTO_APP_VERSION=${version}`],
  },
];

describe('release version displays', () => {
  it.each(versionDisplays)(
    'keeps $path aligned with package.json',
    ({ path: sourcePath, expected }) => {
      const source = readFileSync(path.resolve(sourcePath), 'utf8');

      for (const literal of expected) {
        expect(source, `${sourcePath} is missing ${literal}`).toContain(
          literal,
        );
      }
    },
  );

  it('builds package references before release type checking', () => {
    const workflow = readFileSync(
      path.resolve('.github/workflows/release.yml'),
      'utf8',
    );
    const qualityGateStart = workflow.indexOf(
      '      - name: Release quality gates',
    );
    const focusedTestsStart = workflow.indexOf(
      '      - name: Focused regression tests',
      qualityGateStart,
    );
    const qualityGate = workflow.slice(qualityGateStart, focusedTestsStart);

    expect(qualityGateStart).toBeGreaterThanOrEqual(0);
    expect(focusedTestsStart).toBeGreaterThan(qualityGateStart);
    expect(qualityGate.indexOf('npm run build')).toBeGreaterThanOrEqual(0);
    expect(qualityGate.indexOf('npm run build')).toBeLessThan(
      qualityGate.indexOf('npm run typecheck'),
    );
    expect(workflow).toContain('      - name: Install dependencies\n        run: npm ci');
    expect(workflow).not.toContain(
      '      - name: Install dependencies\n        run: npm install',
    );

    const ciWorkflow = readFileSync(
      path.resolve('.github/workflows/ci.yml'),
      'utf8',
    );
    expect(ciWorkflow).toMatch(/Install dependencies\n\s+run: npm ci/);
    expect(ciWorkflow).not.toMatch(/Install dependencies\n\s+run: npm install/);
  });
});
