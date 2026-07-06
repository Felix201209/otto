/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * DoctorService 单测：验证 present/absent/version 解析、playwright 走模块解析（非 PATH）、
 * mac .app 兜底、平台过滤、安装 hint 按平台，以及报告渲染。
 * 通过注入 runner/resolver 模拟环境，不 mock 全局模块。
 */
import { describe, it, expect } from 'vitest';
import {
  DoctorService,
  formatDoctorReport,
  type CommandRunner,
  type ModuleResolver,
  type PathChecker,
  type DoctorReport,
} from './doctor.js';

/**
 * 构造一个 fake runner：按「本机真实基线」模拟 —— 已装 ffmpeg/whisper/pdfunite，
 * 其余二进制未装（which 失败）。which 命中的返回路径，--version 返回带版本号的串。
 */
function makeRunner(
  present: Record<string, { path: string; version: string }>,
): CommandRunner {
  return async (command: string): Promise<string> => {
    // which <bin>
    const whichMatch = command.match(/^which\s+(\S+)/);
    if (whichMatch) {
      const bin = whichMatch[1];
      if (present[bin]) return present[bin].path;
      throw new Error(`which: ${bin} not found`);
    }
    // where <bin>  (windows)
    const whereMatch = command.match(/^where\s+(\S+)/);
    if (whereMatch) {
      const bin = whereMatch[1];
      if (present[bin]) return present[bin].path;
      throw new Error(`where: ${bin} not found`);
    }
    // <bin> --version / <bin> <arg>
    const verMatch = command.match(/^(\S+)\s/);
    if (verMatch) {
      const bin = verMatch[1];
      if (present[bin]) return present[bin].version;
      throw new Error(`${bin}: command not found`);
    }
    throw new Error('unhandled command: ' + command);
  };
}

/** 只解析给定模块名的 resolver；其余抛错。 */
function makeResolver(resolvable: Record<string, string>): ModuleResolver {
  return (moduleName: string): string => {
    if (resolvable[moduleName]) return resolvable[moduleName];
    throw new Error(`Cannot find module '${moduleName}'`);
  };
}

const NO_MODULES: ModuleResolver = () => {
  throw new Error('no modules resolvable');
};

/** 默认：任何 .app 路径都不存在。 */
const NO_APP: PathChecker = () => false;
/** 指定路径集合存在。 */
const appExists = (paths: string[]): PathChecker => (p) => paths.includes(p);

describe('DoctorService', () => {
  it('reports present binary with parsed version and path', async () => {
    const runner = makeRunner({
      ffmpeg: { path: '/opt/homebrew/bin/ffmpeg', version: 'ffmpeg version 7.1 Copyright (c)' },
    });
    const svc = new DoctorService(runner, NO_MODULES, 'darwin', NO_APP);
    const report = await svc.check();

    const ffmpeg = report.checks.find((c) => c.name === 'ffmpeg')!;
    expect(ffmpeg.present).toBe(true);
    expect(ffmpeg.version).toBe('7.1');
    expect(ffmpeg.path).toBe('/opt/homebrew/bin/ffmpeg');
    expect(ffmpeg.installHint).toBeUndefined();
  });

  it('reports absent binary with platform-specific install hint', async () => {
    const svc = new DoctorService(makeRunner({}), NO_MODULES, 'darwin');
    const report = await svc.check();

    const pandoc = report.checks.find((c) => c.name === 'pandoc')!;
    expect(pandoc.present).toBe(false);
    expect(pandoc.version).toBeUndefined();
    expect(pandoc.installHint).toBe('brew install pandoc');

    // 平台切换 -> hint 也变
    const winReport = await new DoctorService(makeRunner({}), NO_MODULES, 'win32', NO_APP).check();
    const winPandoc = winReport.checks.find((c) => c.name === 'pandoc')!;
    expect(winPandoc.installHint).toContain('winget');
  });

  it('marks present even when --version fails (version unknown)', async () => {
    // which 命中，但 --version 抛错
    const runner: CommandRunner = async (command) => {
      if (/^which\s+duckdb/.test(command)) return '/usr/local/bin/duckdb';
      if (/^which/.test(command)) throw new Error('not found');
      throw new Error('duckdb --version crashed');
    };
    const svc = new DoctorService(runner, NO_MODULES, 'darwin', NO_APP);
    const report = await svc.check();

    const duckdb = report.checks.find((c) => c.name === 'duckdb')!;
    expect(duckdb.present).toBe(true);
    expect(duckdb.version).toBeUndefined();
    expect(duckdb.path).toBe('/usr/local/bin/duckdb');
  });

  it('resolves libreoffice via alternate bin (soffice)', async () => {
    const runner = makeRunner({
      soffice: { path: '/usr/bin/soffice', version: 'LibreOffice 7.6.4.1' },
    });
    const report = await new DoctorService(runner, NO_MODULES, 'linux', NO_APP).check();
    const lo = report.checks.find((c) => c.name === 'libreoffice')!;
    expect(lo.present).toBe(true);
    expect(lo.version).toBe('7.6.4.1');
  });

  it('falls back to LibreOffice.app on macOS when not on PATH', async () => {
    const report = await new DoctorService(
      makeRunner({}),
      NO_MODULES,
      'darwin',
      appExists(['/Applications/LibreOffice.app']),
    ).check();
    const lo = report.checks.find((c) => c.name === 'libreoffice')!;
    expect(lo.present).toBe(true);
    expect(lo.path).toBe('/Applications/LibreOffice.app');
  });

  it('libreoffice absent when neither PATH nor .app present', async () => {
    const report = await new DoctorService(makeRunner({}), NO_MODULES, 'darwin', NO_APP).check();
    const lo = report.checks.find((c) => c.name === 'libreoffice')!;
    expect(lo.present).toBe(false);
  });

  // --- playwright 特殊分支：走 node 模块解析，不看 PATH ---
  it('playwright present via module resolution even if no PATH binary', async () => {
    // runner 里没有任何 playwright 二进制；仅 resolver 能解析
    const resolver = makeResolver({
      playwright: '/repo/node_modules/playwright/index.js',
    });
    const report = await new DoctorService(makeRunner({}), resolver, 'darwin', NO_APP).check();
    const pw = report.checks.find((c) => c.name === 'playwright')!;
    expect(pw.present).toBe(true);
    expect(pw.path).toBe('/repo/node_modules/playwright/index.js');
  });

  it('playwright falls back to playwright-core module', async () => {
    const resolver = makeResolver({
      'playwright-core': '/repo/node_modules/playwright-core/index.js',
    });
    const report = await new DoctorService(makeRunner({}), resolver, 'darwin', NO_APP).check();
    const pw = report.checks.find((c) => c.name === 'playwright')!;
    expect(pw.present).toBe(true);
    expect(pw.path).toContain('playwright-core');
  });

  it('playwright absent when node_modules has neither (global binary must NOT count)', async () => {
    // 关键场景：全局有 `playwright` 二进制（which 命中）但 node_modules 里没有 -> 应判 absent
    const runner = makeRunner({
      playwright: { path: '/usr/local/bin/playwright', version: 'Version 1.40.0' },
    });
    const report = await new DoctorService(runner, NO_MODULES, 'darwin', NO_APP).check();
    const pw = report.checks.find((c) => c.name === 'playwright')!;
    expect(pw.present).toBe(false);
    expect(pw.installHint).toContain('npm i playwright');
  });

  // --- 平台过滤 ---
  it('probes cliclick only on macOS', async () => {
    const mac = await new DoctorService(makeRunner({}), NO_MODULES, 'darwin', NO_APP).check();
    expect(mac.checks.some((c) => c.name === 'cliclick')).toBe(true);

    const linux = await new DoctorService(makeRunner({}), NO_MODULES, 'linux', NO_APP).check();
    expect(linux.checks.some((c) => c.name === 'cliclick')).toBe(false);
  });

  // --- 汇总统计 ---
  it('matches the real machine baseline (ffmpeg/whisper/pdfunite present, rest absent)', async () => {
    // 复刻本机真实状态：已装 ffmpeg/whisper/pdfunite，playwright 不在 node_modules。
    const runner = makeRunner({
      ffmpeg: { path: '/opt/homebrew/bin/ffmpeg', version: 'ffmpeg version 7.1' },
      whisper: { path: '/opt/homebrew/bin/whisper', version: 'whisper 20240930' },
      pdfunite: { path: '/opt/homebrew/bin/pdfunite', version: 'pdfunite version 24.04.0' },
    });
    const report = await new DoctorService(runner, NO_MODULES, 'darwin', NO_APP).check();

    const present = report.checks.filter((c) => c.present).map((c) => c.name).sort();
    expect(present).toEqual(['ffmpeg', 'pdfunite', 'whisper']);

    for (const name of ['pandoc', 'libreoffice', 'typst', 'marp', 'duckdb', 'gnuplot', 'cliclick', 'ghostscript', 'playwright']) {
      expect(report.checks.find((c) => c.name === name)!.present).toBe(false);
    }
    expect(report.presentCount).toBe(3);
    expect(report.affectedCapabilities).toContain('文档转换/生成');
  });
});

describe('formatDoctorReport', () => {
  const report: DoctorReport = {
    platform: 'darwin',
    presentCount: 1,
    missingCount: 1,
    affectedCapabilities: ['文档转换/生成'],
    checks: [
      { name: 'ffmpeg', category: '语音录音', present: true, version: '7.1', path: '/x/ffmpeg' },
      { name: 'pandoc', category: '文档转换/生成', present: false, installHint: 'brew install pandoc' },
    ],
  };

  it('renders present, missing, install hints and affected capabilities', () => {
    const text = formatDoctorReport(report);
    expect(text).toContain('就绪 1 / 缺失 1');
    expect(text).toContain('[OK] ffmpeg v7.1');
    expect(text).toContain('[缺] pandoc');
    expect(text).toContain('brew install pandoc');
    expect(text).toContain('受影响能力：文档转换/生成');
  });

  it('shows (version unknown) marker when present without version', () => {
    const r: DoctorReport = {
      platform: 'linux',
      presentCount: 1,
      missingCount: 0,
      affectedCapabilities: [],
      checks: [{ name: 'duckdb', category: '数据分析', present: true }],
    };
    expect(formatDoctorReport(r)).toContain('（版本未知）');
  });
});
