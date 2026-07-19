/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const script = resolve(
  repoRoot,
  '.otto/skills/copywriting/scripts/create_copy.py',
);
const skillInstructions = readFileSync(
  resolve(repoRoot, '.otto/skills/copywriting/SKILL.md'),
  'utf8',
);
const tempRoots: string[] = [];

type PythonLauncher = {
  command: string;
  prefixArgs: string[];
};

function findPython3(): PythonLauncher | undefined {
  const candidates: PythonLauncher[] =
    process.platform === 'win32'
      ? [
          { command: 'py', prefixArgs: ['-3'] },
          { command: 'python3', prefixArgs: [] },
          { command: 'python', prefixArgs: [] },
        ]
      : [
          { command: 'python3', prefixArgs: [] },
          { command: 'python', prefixArgs: [] },
        ];
  return candidates.find(
    ({ command, prefixArgs }) =>
      spawnSync(command, [...prefixArgs, '--version'], { encoding: 'utf8' })
        .status === 0,
  );
}

const python = findPython3();

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'otto-copywriting-'));
  tempRoots.push(root);
  return root;
}

function runCopywriting(
  config: Record<string, unknown>,
  outputRelative = 'nested/delivery/copy.html',
) {
  if (!python) throw new Error('Python 3 is required for this delivery test');
  const root = makeTempRoot();
  const configPath = join(root, 'config.json');
  const outputPath = join(root, outputRelative);
  writeFileSync(configPath, JSON.stringify(config), 'utf8');
  const result = spawnSync(
    python.command,
    [...python.prefixArgs, script, configPath, outputPath],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  return { root, outputPath, result };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('copywriting Python 3 交付脚本', () => {
  it.skipIf(!python)(
    '空数组安全回退、创建父目录，并在三种产物中真正渲染 proofs',
    () => {
      const { outputPath, result } = runCopywriting({
        brand: '安全品牌',
        category: '团队工具',
        audience: '研发团队',
        value_prop: '让信息更清楚',
        differentiator: '统一工作入口',
        pain_points: [],
        benefits: [],
        ctas: [],
        proofs: [
          { number: '42%', label: '经审核的效率改善' },
          '<img src=x onerror=alert(1)>',
        ],
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('OK copy.html');

      const htmlPath = outputPath;
      const mdPath = outputPath.replace(/\.html$/, '.md');
      const txtPath = outputPath.replace(/\.html$/, '.txt');
      expect(existsSync(htmlPath)).toBe(true);
      expect(existsSync(mdPath)).toBe(true);
      expect(existsSync(txtPath)).toBe(true);

      const html = readFileSync(htmlPath, 'utf8');
      const markdown = readFileSync(mdPath, 'utf8');
      const text = readFileSync(txtPath, 'utf8');
      expect(html).toContain('background:#122033');
      expect(html).toContain('solid #1E7A5F');
      expect(html).toContain('工具切换太多');
      expect(html).toContain('把分散工作收进一个入口');
      expect(html).toContain('预约 15 分钟演示');
      expect(html).toContain('42%');
      expect(html).toContain('经审核的效率改善');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(markdown).toContain('42%');
      expect(markdown).toContain('经审核的效率改善');
      expect(text).toContain('42%');
      expect(text).toContain('经审核的效率改善');
    },
  );

  it.skipIf(!python).each([
    ['base', '#112233;}</style><script>alert(1)</script>'],
    ['base', ''],
    ['accent', '1E7A5F'],
    ['accent', '#abcd'],
  ])('非法 %s 颜色 fail closed，不生成或注入产物', (field, value) => {
    const marker = 'COPY_COLOR_INJECTION_MARKER';
    const { outputPath, result } = runCopywriting({
      brand: marker,
      [field]: value,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${field} must use #RRGGBB`);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(outputPath.replace(/\.html$/, '.md'))).toBe(false);
    expect(existsSync(outputPath.replace(/\.html$/, '.txt'))).toBe(false);
  });

  it.skipIf(!python)('接受并规范合法颜色为大写 #RRGGBB', () => {
    const { outputPath, result } = runCopywriting({
      base: '#a1b2c3',
      accent: '#0d9e8f',
    });

    expect(result.status, result.stderr).toBe(0);
    const html = readFileSync(outputPath, 'utf8');
    expect(html).toContain('background:#A1B2C3');
    expect(html).toContain('solid #0D9E8F');
  });

  it('文档同时给出 macOS/Linux 和 Windows 的 Python 3 命令，不写死用户目录', () => {
    expect(skillInstructions).toMatch(/macOS|Linux/);
    expect(skillInstructions).toContain('python3');
    expect(skillInstructions).toContain('py -3');
    expect(skillInstructions).toContain('.otto-user');
    expect(skillInstructions).not.toContain('python .otto/skills/');
    expect(skillInstructions).not.toMatch(/\/Users\/[^/]+|C:\\Users\\[^\\]+/);
  });
});
