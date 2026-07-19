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
});
