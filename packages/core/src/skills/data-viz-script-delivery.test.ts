/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const skillRoot = resolve(repoRoot, '.otto/skills/data-viz-pro');
const analyzeScript = resolve(skillRoot, 'scripts/analyze_data.py');
const chartScript = resolve(skillRoot, 'scripts/create_chart.py');
const skillInstructions = readFileSync(resolve(skillRoot, 'SKILL.md'), 'utf8');
const analyzeSource = readFileSync(analyzeScript, 'utf8');
const chartSource = readFileSync(chartScript, 'utf8');

type PythonLauncher = {
  command: string;
  prefix: string[];
};

function findPython3(): PythonLauncher | undefined {
  const candidates: PythonLauncher[] =
    process.platform === 'win32'
      ? [
          { command: 'py', prefix: ['-3'] },
          { command: 'python3', prefix: [] },
          { command: 'python', prefix: [] },
        ]
      : [
          { command: 'python3', prefix: [] },
          { command: 'python', prefix: [] },
        ];
  return candidates.find(
    ({ command, prefix }) =>
      spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' })
        .status === 0,
  );
}

const pythonRuntime = findPython3();

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function runPython(args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (!pythonRuntime)
    throw new Error('Python 3 is required for this delivery test');
  return spawnSync(pythonRuntime.command, [...pythonRuntime.prefix, ...args], {
    encoding: 'utf8',
    env,
  });
}

function pythonEnvironmentWithoutPlottingDependencies(): NodeJS.ProcessEnv {
  const blockers = makeTemporaryDirectory('otto-data-viz-blocked-deps-');
  writeFileSync(
    resolve(blockers, 'matplotlib.py'),
    'raise ImportError("matplotlib intentionally unavailable in delivery test")\n',
  );
  writeFileSync(
    resolve(blockers, 'numpy.py'),
    'raise ImportError("numpy intentionally unavailable in delivery test")\n',
  );
  return {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONPATH: blockers,
  };
}

function runRenderHarness(mode: 'failed' | 'missing' | 'empty') {
  const outputDirectory = makeTemporaryDirectory('otto-data-viz-render-');
  const harness = `
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("otto_analyze_data", ${JSON.stringify(analyzeScript)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

module._read_table = lambda _path: object()
module._classify_columns = lambda _df: ([], [], [])
module._metric_columns = lambda _df, _columns: []
module._dataset_profile = lambda *_args: {
    "rows": 1,
    "columns": 1,
    "column_names": ["value"],
    "numeric_columns": [],
    "metric_columns": [],
    "categorical_columns": [],
    "date_columns": [],
    "missing_cells": 0,
    "numeric_summary": {},
}
module._insights = lambda *_args: []
module.recommend_charts = lambda *_args: [(
    "delivery_test",
    {
        "type": "bar",
        "title": "delivery test",
        "data": {
            "x_labels": ["A"],
            "series": [{"name": "value", "values": [1]}],
        },
    },
)]

def fake_run(argv, **_kwargs):
    output = Path(argv[-1])
    if ${JSON.stringify(mode)} == "empty":
        output.touch()
        output.with_suffix(".svg").touch()
    return SimpleNamespace(
        returncode=7 if ${JSON.stringify(mode)} == "failed" else 0,
        stdout="",
        stderr="renderer exploded" if ${JSON.stringify(mode)} == "failed" else "",
    )

module.subprocess.run = fake_run
module.write_outputs(Path("input.csv"), Path(${JSON.stringify(outputDirectory)}), True)
`;
  const result = runPython(['-c', harness], {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
  });
  const manifestPath = resolve(outputDirectory, 'manifest.json');
  let manifest: unknown = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    // A failed render should not publish a manifest.
  }
  return { result, manifest };
}

describe('data-viz-pro 脚本交付门槛', () => {
  it.skipIf(!pythonRuntime)(
    '未安装 matplotlib/numpy 时仍可查看 create_chart --help',
    () => {
      const result = runPython(
        [chartScript, '--help'],
        pythonEnvironmentWithoutPlottingDependencies(),
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('usage:');
      expect(result.stdout).toContain('input');
      expect(result.stdout).toContain('output');
    },
  );

  it.skipIf(!pythonRuntime).each([
    ['渲染子进程失败', 'failed' as const],
    ['渲染器未生成文件', 'missing' as const],
    ['渲染器只生成空文件', 'empty' as const],
  ])('%s 时分析命令非零退出且不发布无效图片路径', (_label, mode) => {
    const { result, manifest } = runRenderHarness(mode);

    expect(result.status).not.toBe(0);
    if (manifest && typeof manifest === 'object' && 'charts' in manifest) {
      for (const chart of (manifest as { charts: Record<string, unknown>[] })
        .charts) {
        expect(chart).not.toHaveProperty('png');
        expect(chart).not.toHaveProperty('svg');
      }
    }
  });

  it.skipIf(!pythonRuntime)(
    '拒绝过大的画布、DPI 和点数，并为 stacked 系列计算真实累加基线',
    () => {
      const harness = `
import importlib.util
import json

spec = importlib.util.spec_from_file_location("otto_create_chart", ${JSON.stringify(chartScript)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

invalid = [
    {"type": "bar", "figsize": [100, 6], "data": {}},
    {"type": "bar", "dpi": 5000, "data": {}},
    {
        "type": "scatter",
        "data": {
            "series": [{
                "x": list(range(module.MAX_TOTAL_POINTS + 1)),
                "y": list(range(module.MAX_TOTAL_POINTS + 1)),
            }],
        },
    },
]
rejected = 0
for config in invalid:
    try:
        module._validate_config(config)
    except ValueError:
        rejected += 1

layout = module._stacked_layout(
    [{"values": [1, 2]}, {"values": [3, 4]}],
    2,
)
print(json.dumps({"rejected": rejected, "layout": layout}))
`;
      const result = runPython(
        ['-c', harness],
        pythonEnvironmentWithoutPlottingDependencies(),
      );

      expect(result.status, result.stderr).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        rejected: number;
        layout: Array<{ offsets: number[]; values: number[] }>;
      };
      expect(payload.rejected).toBe(3);
      expect(payload.layout).toEqual([
        { offsets: [0, 0], values: [1, 2] },
        { offsets: [1, 2], values: [3, 4] },
      ]);
    },
  );

  it('限制输入行数，并在类别统计前过滤缺失值', () => {
    expect(analyzeSource).toContain('MAX_INPUT_ROWS');
    expect(analyzeSource).toContain('nrows=MAX_INPUT_ROWS + 1');
    expect(analyzeSource).toContain(
      'df[cat_col].dropna().astype(str).value_counts()',
    );
    expect(analyzeSource).toContain(
      'df[col].dropna().astype(str).value_counts()',
    );
    expect(analyzeSource).toContain(
      'date_cols.append(col)\n                continue',
    );
    expect(analyzeSource).not.toContain(
      '"source": "Otto Data-Viz-Pro 自动分析"',
    );
    expect(analyzeSource).toContain('cfg["source"] = input_path.name');
  });

  it('声明完整运行依赖，并提供跨平台 Python 3 命令', () => {
    const requirements = readFileSync(
      resolve(skillRoot, 'requirements.txt'),
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
      expect(requirements).toMatch(new RegExp(`^${dependency}[<=>]`, 'm'));
    }
    expect(skillInstructions).toContain('python3 -m pip install');
    expect(skillInstructions).toContain('py -3 -m pip install');
    expect(skillInstructions).toContain('.otto-user');
    expect(skillInstructions).toContain(
      'python3 "$DATA_VIZ_SKILL_DIR/scripts/analyze_data.py"',
    );
    expect(skillInstructions).toContain(
      'py -3 "$DataVizSkillDir\\scripts\\analyze_data.py"',
    );
    expect(skillInstructions).not.toContain('.otto/skills');
    expect(skillInstructions).not.toMatch(/\/Users\/|[A-Z]:\\\\Users\\\\/);
    expect(analyzeSource).not.toMatch(/\.otto(?:-user)?\/skills/);
    expect(chartSource).not.toMatch(/\.otto(?:-user)?\/skills/);
  });
});
