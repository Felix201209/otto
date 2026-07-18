/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.dirname(fileURLToPath(import.meta.url));

function rendererSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return rendererSources(target);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (entry.name.includes('.test.')) return [];
    return [target];
  });
}

describe('renderer runtime import boundary', () => {
  it('otto-server/otto-core only enter as types, never as renderer runtime code', () => {
    const violations = rendererSources(rendererRoot).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      const imports = source.match(/^[ \t]*import[\s\S]*?;[ \t]*$/gm) ?? [];
      const staticViolations = imports
        .filter((statement) =>
          /(?:from\s+)?['"]otto-(?:server|core)(?:\/[^'"]*)?['"]/.test(statement),
        )
        .filter((statement) => !statement.trimStart().startsWith('import type '))
        .map((statement) => ({
          file: path.relative(rendererRoot, file),
          statement: statement.replace(/\s+/g, ' ').trim(),
        }));
      const callViolations = [...source.matchAll(
        /\b(?:require|import)\(\s*['"]otto-(?:server|core)(?:\/[^'"]*)?['"]\s*\)/g,
      )].map((match) => ({
        file: path.relative(rendererRoot, file),
        statement: match[0],
      }));
      return [...staticViolations, ...callViolations];
    });

    expect(violations).toEqual([]);
  });
});
