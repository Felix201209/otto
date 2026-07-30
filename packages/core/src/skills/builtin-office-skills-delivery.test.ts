/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadBuiltinSkillInstructions } from './seed-skills.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const rootSkills = resolve(repoRoot, '.otto/skills');
const seedSkills = resolve(repoRoot, 'packages/core/skills-seed');
const upgradedSkills = {
  copywriting: ['SKILL.md', 'scripts/create_copy.py'],
  'data-viz-pro': [
    'SKILL.md',
    'requirements.txt',
    'scripts/analyze_data.py',
    'scripts/create_chart.py',
  ],
  'market-research': ['SKILL.md', 'scripts/create_research.py'],
} as const;

function filesUnder(root: string, current = root): string[] {
  return readdirSync(current, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.name !== '__pycache__' &&
        entry.name !== '.DS_Store' &&
        entry.name !== 'output' &&
        !entry.name.endsWith('.pyc'),
    )
    .flatMap((entry) => {
      const path = resolve(current, entry.name);
      return entry.isDirectory()
        ? filesUnder(root, path)
        : [relative(root, path).replaceAll('\\', '/')];
    })
    .sort();
}

describe('升级后的办公 Skill 随客户端真实分发', () => {
  for (const [name, expectedFiles] of Object.entries(upgradedSkills)) {
    it(`${name} 的受管 seed 与开发源完全一致，且运行时能直接读取`, () => {
      const sourceDir = resolve(rootSkills, name);
      const seedDir = resolve(seedSkills, name);
      const sourceFiles = filesUnder(sourceDir);
      const seedFiles = filesUnder(seedDir);

      expect(sourceFiles).toEqual([...expectedFiles]);
      expect(seedFiles).toEqual([...expectedFiles]);
      expect(seedFiles).toContain('SKILL.md');
      expect(seedFiles.some((file) => file.startsWith('scripts/'))).toBe(true);

      for (const file of sourceFiles) {
        const sourcePath = resolve(sourceDir, file);
        const seedPath = resolve(seedDir, file);
        expect(statSync(seedPath).isFile()).toBe(true);
        expect(readFileSync(seedPath)).toEqual(readFileSync(sourcePath));
      }

      expect(loadBuiltinSkillInstructions(name)).toBe(
        readFileSync(resolve(seedDir, 'SKILL.md'), 'utf8'),
      );
    });
  }

  it('数据可视化 Skill 随包携带可重建的 Python 依赖清单', () => {
    const requirements = readFileSync(
      resolve(seedSkills, 'data-viz-pro/requirements.txt'),
      'utf8',
    );
    for (const dependency of [
      'pandas',
      'openpyxl',
      'xlrd',
      'matplotlib',
      'numpy',
      'scipy',
    ]) {
      expect(requirements).toMatch(
        new RegExp(`^${dependency}(?:[<>=!~]|$)`, 'm'),
      );
    }
  });
});
