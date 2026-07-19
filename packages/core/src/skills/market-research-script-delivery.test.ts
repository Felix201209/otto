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
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const skillDir = resolve(repoRoot, '.otto/skills/market-research');
const script = resolve(skillDir, 'scripts/create_research.py');
const skillInstructions = readFileSync(resolve(skillDir, 'SKILL.md'), 'utf8');
const tempDirs: string[] = [];

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

function runScript(config: unknown, output: string) {
  if (!python) throw new Error('Python 3 is required for this delivery test');
  const dir = mkdtempSync(join(tmpdir(), 'otto-market-research-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config), 'utf8');
  return spawnSync(
    python.command,
    [...python.prefixArgs, script, configPath, output],
    { encoding: 'utf8' },
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('market-research 脚本交付安全', () => {
  it('文档使用安装后的 Skill 路径和跨平台 Python 3 启动方式', () => {
    expect(skillInstructions).not.toContain('python .otto/skills/');
    expect(skillInstructions).toContain('.otto-user');
    expect(skillInstructions).toContain('python3');
    expect(skillInstructions).toContain('py -3');
  });

  it.skipIf(!python)('拒绝可逃逸 CSS 的颜色值，不生成注入后的 HTML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'otto-market-injection-'));
    tempDirs.push(dir);
    const output = join(dir, 'report.html');
    const result = runScript(
      {
        brand: '安全测试',
        base: '#123456;} </style><script>globalThis.pwned=1</script>',
        accent: '#2563EB',
      },
      output,
    );

    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  it.skipIf(!python)(
    '补足至少三家竞品，并能向尚不存在的父目录写出全部产物',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'otto-market-output-'));
      tempDirs.push(dir);
      const output = join(dir, 'nested', 'report.html');
      const result = runScript(
        {
          brand: 'Otto',
          industry: 'ai',
          competitors: [{ name: '竞品 A' }],
          trends: [],
          drivers: [],
          risks: [],
          metrics: [],
        },
        output,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(output)).toBe(true);
      expect(existsSync(output.replace(/\.html$/, '.md'))).toBe(true);
      expect(existsSync(output.replace(/\.html$/, '.csv'))).toBe(true);
      expect(existsSync(output.replace(/\.html$/, '.sources.json'))).toBe(true);

      const html = readFileSync(output, 'utf8');
      const csv = readFileSync(output.replace(/\.html$/, '.csv'), 'utf8');
      expect(html).toContain('background:#132238');
      expect(html).toContain('border-bottom:6px solid #2563EB');
      expect(csv.trim().split(/\r?\n/)).toHaveLength(4);
    },
  );

  it.skipIf(!python)(
    '不把占位来源和行业模板冒充事实，并阻断 CSV 公式注入',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'otto-market-truth-'));
      tempDirs.push(dir);
      const output = join(dir, 'report.html');
      const result = runScript(
        {
          brand: 'Otto',
          industry: 'ai',
          competitors: [
            {
              name: '=HYPERLINK("https://evil.example","click")',
              pricing: '+1',
              sources: ['待补充'],
            },
          ],
          sources: [{ title: '尚未核实的来源' }],
          swot: {
            strengths: ['用户输入优势'],
            weaknesses: ['用户输入劣势'],
            opportunities: ['用户输入机会'],
            threats: ['用户输入威胁'],
          },
        },
        output,
      );

      expect(result.status, result.stderr).toBe(0);
      const html = readFileSync(output, 'utf8');
      const csv = readFileSync(output.replace(/\.html$/, '.csv'), 'utf8');
      const sources = JSON.parse(
        readFileSync(output.replace(/\.html$/, '.sources.json'), 'utf8'),
      ) as {
        sources: Array<{ date: string; tier: string }>;
        missing_evidence: Array<{ competitor: string; field: string }>;
      };

      expect(html).toContain('行业模板假设，待核实');
      expect(html).toContain('证据与来源');
      expect(html).toContain('尚未核实的来源');
      for (const className of ['s', 'w', 'o', 't']) {
        const swotCard = html.match(
          new RegExp(
            `<div class='swot ${className}'>[\\s\\S]*?<ul>([\\s\\S]*?)</ul>`,
          ),
        );
        expect(
          swotCard?.[1].match(/<li>/g)?.length ?? 0,
        ).toBeGreaterThanOrEqual(3);
      }
      expect(csv).toContain(`'=HYPERLINK`);
      expect(csv).toContain(`'+1`);
      expect(csv).not.toContain('有来源');
      expect(sources.sources[0]).toMatchObject({
        date: '待补充',
        tier: '待核实',
      });
      expect(sources.missing_evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            competitor: '市场概览',
            field: '核心趋势',
          }),
          expect.objectContaining({
            competitor: '市场概览',
            field: '增长驱动',
          }),
          expect.objectContaining({
            competitor: '市场概览',
            field: '主要风险',
          }),
        ]),
      );
      expect(readFileSync(output.replace(/\.html$/, '.md'), 'utf8')).toContain(
        '## 证据与来源',
      );
    },
  );
});
