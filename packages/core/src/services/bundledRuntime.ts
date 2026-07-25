/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Runtime contract for document generation in packaged Otto desktop builds.
 * No binary is downloaded here: packaging must place platform resources under
 * `<resourcesPath>/runtime/<platform>-<arch>` and the verifier fails loud when
 * required files are absent. Development/CLI builds retain explicit PATH
 * fallbacks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type DocumentRuntimeKind = 'python' | 'node' | 'libreoffice';
export type RuntimeSource = 'bundled' | 'system';

export interface DocumentRuntimeResolution {
  executable: string;
  source: RuntimeSource;
  runtimeRoot?: string;
  pythonSitePackages?: string;
}

export interface ResolveDocumentRuntimeOptions {
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  pathExists?: (candidate: string) => boolean;
}

export interface InspectBundledDocumentRuntimeOptions {
  runtimeRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  pathExists?: (candidate: string) => boolean;
}

export interface BundledDocumentRuntimeReport {
  ready: boolean;
  runtimeRoot: string;
  missingRequired: string[];
  message: string;
}

function processResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

export function bundledRuntimeRoot(
  options: ResolveDocumentRuntimeOptions = {},
): string | undefined {
  const resourcesPath =
    options.resourcesPath ??
    process.env['OTTO_RESOURCES_PATH']?.trim() ??
    processResourcesPath();
  if (!resourcesPath) return undefined;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  return path.join(resourcesPath, 'runtime', `${platform}-${arch}`);
}

function bundledExecutableCandidates(
  kind: DocumentRuntimeKind,
  root: string,
  platform: NodeJS.Platform,
): string[] {
  if (kind === 'python') {
    return platform === 'win32'
      ? [
          path.join(root, 'python', 'python.exe'),
          path.join(root, 'bin', 'python.exe'),
        ]
      : [
          path.join(root, 'python', 'bin', 'python3'),
          path.join(root, 'bin', 'python3'),
        ];
  }
  if (kind === 'node') {
    return platform === 'win32'
      ? [
          path.join(root, 'node', 'node.exe'),
          path.join(root, 'bin', 'node.exe'),
        ]
      : [
          path.join(root, 'node', 'bin', 'node'),
          path.join(root, 'bin', 'node'),
        ];
  }
  if (platform === 'win32') {
    return [
      path.join(root, 'libreoffice', 'program', 'soffice.exe'),
      path.join(root, 'bin', 'soffice.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      path.join(
        root,
        'libreoffice',
        'LibreOffice.app',
        'Contents',
        'MacOS',
        'soffice',
      ),
      path.join(root, 'libreoffice', 'program', 'soffice'),
      path.join(root, 'bin', 'soffice'),
    ];
  }
  return [
    path.join(root, 'libreoffice', 'program', 'soffice'),
    path.join(root, 'bin', 'soffice'),
  ];
}

function systemExecutable(
  kind: DocumentRuntimeKind,
  platform: NodeJS.Platform,
): string {
  if (kind === 'python') return platform === 'win32' ? 'python' : 'python3';
  if (kind === 'node') return 'node';
  return platform === 'win32' ? 'soffice' : 'libreoffice';
}

export function resolveDocumentRuntime(
  kind: DocumentRuntimeKind,
  options: ResolveDocumentRuntimeOptions = {},
): DocumentRuntimeResolution {
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? fs.existsSync;
  const root = bundledRuntimeRoot(options);
  if (root) {
    const executable = bundledExecutableCandidates(kind, root, platform).find(
      (candidate) => pathExists(candidate),
    );
    if (executable) {
      return {
        executable,
        source: 'bundled',
        runtimeRoot: root,
        ...(kind === 'python'
          ? { pythonSitePackages: path.join(root, 'python', 'site-packages') }
          : {}),
      };
    }
  }
  if (kind === 'libreoffice' && platform === 'darwin') {
    const macSystemExecutable =
      '/Applications/LibreOffice.app/Contents/MacOS/soffice';
    if (pathExists(macSystemExecutable)) {
      return { executable: macSystemExecutable, source: 'system' };
    }
  }
  return { executable: systemExecutable(kind, platform), source: 'system' };
}

export function buildBundledPythonEnvironment(
  resolution: DocumentRuntimeResolution,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (resolution.source !== 'bundled' || !resolution.pythonSitePackages)
    return env;
  env.PYTHONPATH = [resolution.pythonSitePackages, baseEnv.PYTHONPATH]
    .filter((value): value is string => Boolean(value))
    .join(path.delimiter);
  env.PATH = [path.dirname(resolution.executable), baseEnv.PATH]
    .filter((value): value is string => Boolean(value))
    .join(path.delimiter);
  env.PYTHONNOUSERSITE = '1';
  return env;
}

export function inspectBundledDocumentRuntime(
  options: InspectBundledDocumentRuntimeOptions,
): BundledDocumentRuntimeReport {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pathExists = options.pathExists ?? fs.existsSync;
  const root = options.runtimeRoot;
  const hasExecutable = (kind: DocumentRuntimeKind) =>
    bundledExecutableCandidates(kind, root, platform).some(pathExists);
  const missingRequired: string[] = [];
  if (!hasExecutable('python')) missingRequired.push('python executable');
  if (!hasExecutable('node')) missingRequired.push('node executable');
  for (const moduleName of ['docx', 'jinja2', 'markdown', 'fpdf']) {
    if (!pathExists(path.join(root, 'python', 'site-packages', moduleName))) {
      missingRequired.push(`python site-packages/${moduleName}`);
    }
  }
  if (!hasExecutable('libreoffice'))
    missingRequired.push('LibreOffice executable');
  const ready = missingRequired.length === 0;
  const requiredSummary = ready
    ? 'Python、Node.js、必需 Python 模块（含 fpdf2）与 LibreOffice 齐全。'
    : `缺少必需组件：${missingRequired.join('、')}；桌面安装包打包必须失败。`;
  return {
    ready,
    runtimeRoot: root,
    missingRequired,
    message: `[${platform}-${arch}] ${requiredSummary}`,
  };
}
