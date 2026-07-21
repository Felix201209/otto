/**
 * Otto 诊断包：收集排障所需的日志和环境信息，并在写入前统一脱敏。
 * 设计目标：用户点击一次即可生成 zip；任何 secret 文件和明文密钥都不会进入包。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { DoctorService, formatDoctorReport, type DoctorReport } from './doctor.js';

export interface DiagnosticModelSummary {
  displayName?: string;
  provider?: string;
  baseUrl?: string;
  modelId?: string;
  hasApiKey: boolean;
}

export interface DiagnosticBundleOptions {
  homeDir?: string;
  outputDir?: string;
  models?: DiagnosticModelSummary[];
  doctorReport?: DoctorReport;
  extraLogPaths?: string[];
}

export interface DiagnosticBundleResult {
  ok: boolean;
  path: string;
  fileCount: number;
  message: string;
}

const SECRET_FILE_PARTS = [
  `${path.sep}secrets${path.sep}`,
  'enterprise-auth.json',
  'token',
  'credential',
  'password',
  'app-secret',
];

function isSecretPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return SECRET_FILE_PARTS.some((part) => normalized.includes(part.toLowerCase()));
}

/** 只保留排障信息，移除常见 token/key/password 字段和疑似密钥值。 */
export function redactDiagnosticText(input: string): string {
  return input
    .replace(/("(?:apiKey|api_key|appSecret|app_secret|accessToken|refreshToken|token|password|secret)"\s*:\s*")(.*?)(")/gi, '$1[REDACTED]$3')
    .replace(/((?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ark-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]');
}

async function addFile(zip: JSZip, sourcePath: string, targetPath: string): Promise<boolean> {
  if (isSecretPath(sourcePath)) return false;
  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return false;
    const content = await fs.readFile(sourcePath, 'utf8');
    zip.file(targetPath, redactDiagnosticText(content));
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root: string, prefix: string, zip: JSZip): Promise<number> {
  let count = 0;
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const source = path.join(root, entry.name);
      if (entry.name === 'secrets' || isSecretPath(source)) continue;
      if (entry.isDirectory()) {
        count += await collectFiles(source, `${prefix}/${entry.name}`, zip);
      } else if (await addFile(zip, source, `${prefix}/${entry.name}`)) {
        count += 1;
      }
    }
  } catch {
    // 日志目录不存在或无权限时跳过，不阻断诊断包生成。
  }
  return count;
}

export async function createDiagnosticBundle(options: DiagnosticBundleOptions = {}): Promise<DiagnosticBundleResult> {
  const homeDir = options.homeDir ?? os.homedir();
  const outputDir = options.outputDir ?? path.join(homeDir, 'Desktop');
  const report = options.doctorReport ?? await new DoctorService().check();
  const zip = new JSZip();
  let fileCount = 0;

  let models = (options.models ?? []).map((model) => ({
    displayName: model.displayName,
    provider: model.provider,
    baseUrl: model.baseUrl,
    modelId: model.modelId,
    hasApiKey: Boolean(model.hasApiKey),
  }));
  if (models.length === 0) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(homeDir, '.otto-user', 'custom-models.json'), 'utf8')) as { models?: Array<Record<string, unknown>> };
      models = (raw.models ?? []).map((model) => ({
        displayName: typeof model.displayName === 'string' ? model.displayName : undefined,
        provider: typeof model.provider === 'string' ? model.provider : undefined,
        baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : undefined,
        modelId: typeof model.modelId === 'string' ? model.modelId : undefined,
        hasApiKey: Boolean(model.apiKey),
      }));
    } catch {
      // 未配置自定义模型时保留空列表。
    }
  }
  zip.file('environment.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    ottoVersion: process.env.OTTO_VERSION ?? 'unknown',
  }, null, 2));
  zip.file('model-config.json', JSON.stringify({ models }, null, 2));
  zip.file('dependency-report.txt', formatDoctorReport(report));

  fileCount += await collectFiles(path.join(homeDir, '.otto-user', 'logs'), 'otto-user/logs', zip);
  fileCount += await collectFiles(path.join(homeDir, '.otto-user', 'audit'), 'otto-user/audit', zip);
  const desktopLogCandidates = process.platform === 'darwin'
    ? [path.join(homeDir, 'Library', 'Logs', 'Otto')]
    : process.platform === 'win32'
      ? [path.join(process.env.APPDATA ?? homeDir, 'Otto', 'logs')]
      : [path.join(homeDir, '.config', 'Otto', 'logs')];
  for (const logDir of desktopLogCandidates) {
    fileCount += await collectFiles(logDir, 'desktop/logs', zip);
  }
  for (const logPath of options.extraLogPaths ?? []) {
    if (await addFile(zip, logPath, `extra/${path.basename(logPath)}`)) fileCount += 1;
  }

  await fs.mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[.:]/g, '-');
  const outputPath = path.join(outputDir, `otto-diagnostic-${stamp}.zip`);
  await fs.writeFile(outputPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { ok: true, path: outputPath, fileCount, message: `诊断包已生成：${outputPath}` };
}
