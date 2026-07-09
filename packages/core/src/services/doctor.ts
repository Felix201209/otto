/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * DoctorService — 一次性体检 Otto 七大能力所依赖的全部外部二进制/模块 + （可选）系统权限。
 *
 * 背景：Otto 的文档转换/生成、幻灯片、数据分析、桌面键鼠、语音、PDF 处理等能力，
 * 依赖约 10 个外部 CLI（pandoc / libreoffice / typst / marp / duckdb / gnuplot /
 * cliclick / ffmpeg / whisper / ghostscript / pdfunite）以及 playwright（node 模块）。
 * 缺依赖时这些能力只能「跑到一半才 fail」。DoctorService 把体检提前到一次调用里：
 * 就绪 / 缺失 / 各自服务哪个能力 / 按平台的安装命令，一次给全。
 *
 * 设计：探测器（runner）和模块解析器（resolver）都可注入，默认包装 child_process /
 * require.resolve，便于单元测试在不 mock 全局模块的前提下模拟 present/absent/version。
 * 全部探测均为只读、带超时保护，任何单项失败都不影响其它项。
 */

import { exec } from 'child_process';
import { existsSync } from 'fs';
import { createRequire } from 'module';

/** 一次探测的结果。 */
export interface DoctorCheck {
  /** 依赖名（面向用户，如 "pandoc"、"playwright"）。 */
  name: string;
  /** 它服务哪个 Otto 能力（面向用户，如 "文档转换"）。 */
  category: string;
  /** 是否可用。 */
  present: boolean;
  /** 探测到的版本号（拿不到则 undefined，即使 present）。 */
  version?: string;
  /** 可执行文件 / 模块解析路径（拿不到则 undefined）。 */
  path?: string;
  /** 按当前平台给出的安装命令（present 时为 undefined）。 */
  installHint?: string;
  /** 若探测过程本身出错（非「未安装」，而是超时/异常），记录原因。 */
  note?: string;
}

/** 整体体检报告。 */
export interface DoctorReport {
  platform: NodeJS.Platform;
  checks: DoctorCheck[];
  presentCount: number;
  missingCount: number;
  /** 缺失依赖影响到的能力去重列表。 */
  affectedCapabilities: string[];
}

/** 命令执行器：成功返回 stdout，失败（含未安装/非零退出/超时）抛错。可注入以便测试。 */
export type CommandRunner = (
  command: string,
  timeoutMs: number,
) => Promise<string>;

/** 模块解析器：能解析返回绝对路径，否则抛错。可注入以便测试。 */
export type ModuleResolver = (moduleName: string) => string;

/** 路径存在性判断（用于 mac .app 兜底）。可注入以便测试。 */
export type PathChecker = (absPath: string) => boolean;

/** 单个二进制依赖的探测规格。 */
interface BinarySpec {
  name: string;
  category: string;
  /** 用于 PATH 探测的命令名（可给多个候选，任一命中即视为 present）。 */
  bins: string[];
  /** 取版本用的参数，默认 '--version'。 */
  versionArg?: string;
  /** 仅在某些平台探测（如 cliclick 仅 mac）。缺省=全平台。 */
  onlyPlatform?: NodeJS.Platform;
  /** macOS 上的 .app 兜底路径（如 LibreOffice）。 */
  macAppFallback?: string;
  /** 安装命令：按平台给。 */
  hints: Partial<Record<'darwin' | 'win32' | 'linux', string>>;
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 默认命令执行器：包装 child_process.exec。
 * 非零退出 / 命令不存在 / 超时都会 reject（正是我们判定 absent 所需）。
 */
const defaultRunner: CommandRunner = (command, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    const child = exec(
      command,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || stderr || '').trim();
        if (err) {
          // 很多工具打印了版本却以非零码退出（如 ffmpeg --version、pdfunite
          // 走 stderr、whisper 无 --version 打印 usage）。只要有输出就交给上层
          // 去 parse；真正「命令不存在 / which 未命中」这类才是空输出，仍 reject。
          if (out) {
            resolve(out);
            return;
          }
          reject(err);
          return;
        }
        resolve(out);
      },
    );
    child.on('error', reject);
  });

/** 默认模块解析器：相对本文件所在包解析。 */
const defaultResolver: ModuleResolver = (moduleName) => {
  const req = createRequire(__filename);
  return req.resolve(moduleName);
};

/** 被探测的二进制依赖清单。顺序即报告展示顺序（按能力聚类）。 */
const BINARY_SPECS: BinarySpec[] = [
  {
    name: 'pandoc',
    category: '文档转换/生成',
    bins: ['pandoc'],
    hints: {
      darwin: 'brew install pandoc',
      win32: 'winget install --id JohnMacFarlane.Pandoc',
      linux: 'sudo apt-get install -y pandoc',
    },
  },
  {
    name: 'libreoffice',
    category: '文档转换',
    bins: ['libreoffice', 'soffice'],
    macAppFallback: '/Applications/LibreOffice.app',
    hints: {
      darwin: 'brew install --cask libreoffice',
      win32: 'winget install --id TheDocumentFoundation.LibreOffice',
      linux: 'sudo apt-get install -y libreoffice',
    },
  },
  {
    name: 'typst',
    category: '文档生成',
    bins: ['typst'],
    hints: {
      darwin: 'brew install typst',
      win32: 'winget install --id Typst.Typst',
      linux: 'cargo install typst-cli',
    },
  },
  {
    name: 'marp',
    category: '幻灯片生成',
    bins: ['marp', 'marp-cli'],
    hints: {
      darwin: 'npm i -g @marp-team/marp-cli',
      win32: 'npm i -g @marp-team/marp-cli',
      linux: 'npm i -g @marp-team/marp-cli',
    },
  },
  {
    name: 'duckdb',
    category: '数据分析',
    bins: ['duckdb'],
    hints: {
      darwin: 'brew install duckdb',
      win32: 'winget install --id DuckDB.cli',
      linux: 'curl https://install.duckdb.org | sh',
    },
  },
  {
    name: 'gnuplot',
    category: '数据分析出图',
    bins: ['gnuplot'],
    hints: {
      darwin: 'brew install gnuplot',
      win32: 'winget install --id gnuplot.gnuplot',
      linux: 'sudo apt-get install -y gnuplot',
    },
  },
  {
    name: 'cliclick',
    category: '桌面键鼠自动化',
    bins: ['cliclick'],
    onlyPlatform: 'darwin',
    hints: {
      darwin: 'brew install cliclick',
    },
  },
  {
    name: 'ffmpeg',
    category: '语音录音',
    bins: ['ffmpeg'],
    hints: {
      darwin: 'brew install ffmpeg',
      win32: 'winget install --id Gyan.FFmpeg',
      linux: 'sudo apt-get install -y ffmpeg',
    },
  },
  {
    name: 'whisper',
    category: '语音转写',
    bins: ['whisper'],
    hints: {
      darwin: 'pip install -U openai-whisper',
      win32: 'pip install -U openai-whisper',
      linux: 'pip install -U openai-whisper',
    },
  },
  {
    name: 'ghostscript',
    category: 'PDF 压缩',
    bins: ['gs', 'gswin64c'],
    hints: {
      darwin: 'brew install ghostscript',
      win32: 'winget install --id ArtifexSoftware.GhostScript',
      linux: 'sudo apt-get install -y ghostscript',
    },
  },
  {
    name: 'pdfunite',
    category: 'PDF 合并',
    bins: ['pdfunite'],
    hints: {
      darwin: 'brew install poppler',
      win32: 'winget install --id oschwartz10612.Poppler',
      linux: 'sudo apt-get install -y poppler-utils',
    },
  },
];

/** playwright 走 node 模块解析而非 PATH，单列。 */
const PLAYWRIGHT_MODULE_CANDIDATES = ['playwright', 'playwright-core'];

export class DoctorService {
  constructor(
    private readonly runner: CommandRunner = defaultRunner,
    private readonly resolver: ModuleResolver = defaultResolver,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly pathExists: PathChecker = existsSync,
  ) {}

  /** 跑一次全量体检。 */
  async check(): Promise<DoctorReport> {
    const specs = BINARY_SPECS.filter(
      (s) => !s.onlyPlatform || s.onlyPlatform === this.platform,
    );

    const binaryChecks = await Promise.all(
      specs.map((s) => this.probeBinary(s)),
    );
    const playwrightCheck = this.probePlaywright();

    const checks = [...binaryChecks, playwrightCheck];
    const missing = checks.filter((c) => !c.present);
    const affectedCapabilities = Array.from(
      new Set(missing.map((c) => c.category)),
    );

    return {
      platform: this.platform,
      checks,
      presentCount: checks.length - missing.length,
      missingCount: missing.length,
      affectedCapabilities,
    };
  }

  /** 探测单个二进制：先 PATH，再 mac .app 兜底。拿不到版本也如实报 present。 */
  private async probeBinary(spec: BinarySpec): Promise<DoctorCheck> {
    const versionArg = spec.versionArg ?? '--version';

    for (const bin of spec.bins) {
      // 先确认 PATH 里有这个命令（which/where），再取版本。
      const resolvedPath = await this.which(bin);
      if (!resolvedPath) continue;

      const version = await this.tryVersion(bin, versionArg);
      return {
        name: spec.name,
        category: spec.category,
        present: true,
        version,
        path: resolvedPath,
      };
    }

    // mac .app 兜底（如 LibreOffice 没进 PATH 但装了 .app）。
    if (spec.macAppFallback && this.platform === 'darwin') {
      if (this.pathExists(spec.macAppFallback)) {
        return {
          name: spec.name,
          category: spec.category,
          present: true,
          path: spec.macAppFallback,
        };
      }
    }

    return {
      name: spec.name,
      category: spec.category,
      present: false,
      installHint: this.hintFor(spec),
    };
  }

  /** playwright / playwright-core 走模块解析，不看 PATH 二进制。 */
  private probePlaywright(): DoctorCheck {
    for (const mod of PLAYWRIGHT_MODULE_CANDIDATES) {
      try {
        const modulePath = this.resolver(mod);
        return {
          name: 'playwright',
          category: '浏览器自动化',
          present: true,
          path: modulePath,
        };
      } catch {
        // 尝试下一个候选。
      }
    }
    return {
      name: 'playwright',
      category: '浏览器自动化',
      present: false,
      installHint: 'npm i playwright   (然后 npx playwright install)',
    };
  }

  /** 定位命令。默认用 `which <bin>`（Windows 用 `where`）；未命中返回 undefined。 */
  private async which(bin: string): Promise<string | undefined> {
    const locator = this.platform === 'win32' ? 'where' : 'which';
    try {
      const out = await this.runner(`${locator} ${bin}`, DEFAULT_TIMEOUT_MS);
      const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      return first || undefined;
    } catch {
      return undefined;
    }
  }

  /** 取版本；失败返回 undefined（present 但版本未知是合法状态）。 */
  private async tryVersion(
    bin: string,
    versionArg: string,
  ): Promise<string | undefined> {
    try {
      const out = await this.runner(
        `${bin} ${versionArg}`,
        DEFAULT_TIMEOUT_MS,
      );
      return this.parseVersion(out);
    } catch {
      return undefined;
    }
  }

  /**
   * 从 --version 输出里抽第一段 x.y(.z) 版本号。
   * 抽不到时回退到「首行」——但排除 usage/help 文本（有些工具没有版本命令、
   * 会打印帮助，如 whisper），此时返回 undefined（present 但版本未知）。
   */
  private parseVersion(output: string): string | undefined {
    if (!output) return undefined;
    // 支持 2~4 段版本号（LibreOffice 用四段，如 7.6.4.1）。
    const m = output.match(/\d+\.\d+(?:\.\d+){0,2}/);
    if (m) return m[0];
    const firstLine = output.split(/\r?\n/)[0]?.trim() ?? '';
    if (!firstLine || firstLine.length > 60 || /usage[:\s]/i.test(firstLine)) {
      return undefined;
    }
    return firstLine;
  }

  private hintFor(spec: BinarySpec): string {
    return (
      spec.hints[this.platform as 'darwin' | 'win32' | 'linux'] ||
      spec.hints.linux ||
      spec.hints.darwin ||
      '请查阅该工具官方文档安装'
    );
  }
}

/** 把报告渲染成人类可读文本（供 CLI / 工具复用）。 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(
    `Otto 依赖体检（平台：${report.platform}）  就绪 ${report.presentCount} / 缺失 ${report.missingCount}`,
  );
  lines.push('');

  const present = report.checks.filter((c) => c.present);
  const missing = report.checks.filter((c) => !c.present);

  lines.push('就绪：');
  if (present.length === 0) {
    lines.push('  （无）');
  } else {
    for (const c of present) {
      const ver = c.version ? ` v${c.version}` : '（版本未知）';
      lines.push(`  [OK] ${c.name}${ver} — ${c.category}`);
    }
  }
  lines.push('');

  lines.push('缺失：');
  if (missing.length === 0) {
    lines.push('  （无，全部就绪）');
  } else {
    for (const c of missing) {
      lines.push(`  [缺] ${c.name} — 影响：${c.category}`);
      if (c.installHint) lines.push(`       安装：${c.installHint}`);
    }
  }

  if (report.affectedCapabilities.length > 0) {
    lines.push('');
    lines.push(
      `受影响能力：${report.affectedCapabilities.join('、')}（装齐上述依赖后自动解锁）`,
    );
  }

  return lines.join('\n');
}
