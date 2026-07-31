/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const enterpriseDirectory = path.join(import.meta.dirname, 'enterprise');

describe('enterprise HTTP route boundary', () => {
  it('does not bypass module facades with direct SQL or transactions', () => {
    const routeFiles = fs
      .readdirSync(enterpriseDirectory)
      .filter((file) => file.endsWith('Routes.ts') || file === 'server.ts');
    const offenders = routeFiles.flatMap((file) => {
      const source = fs.readFileSync(
        path.join(enterpriseDirectory, file),
        'utf8',
      );
      const violations = [
        ['database connection', /\b(?:db\.)?getDB\s*\(/],
        [
          'SQL statement',
          /\b(?:SELECT\b[\s\S]{0,80}\bFROM|INSERT\s+INTO|UPDATE\s+[a-z_][a-z0-9_]*\s+SET|DELETE\s+FROM)\b/i,
        ],
        [
          'manual transaction',
          /\b(?:BEGIN(?:\s+IMMEDIATE)?|COMMIT|ROLLBACK)\b/i,
        ],
      ] as const;
      return violations
        .filter(([, pattern]) => pattern.test(source))
        .map(([label]) => `${file}: ${label}`);
    });

    expect(offenders).toEqual([]);
  });
});
