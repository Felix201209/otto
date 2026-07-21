/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Static, cross-platform packaging guard. It deliberately does not download
 * runtimes. A release build must provide the declared Python/Node payload;
 * LibreOffice is also required: a desktop installer claiming the full document
 * feature set must not silently ship without Office/PDF conversion support.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultVendorRoot = path.resolve(scriptDir, '..', 'vendor', 'runtime');

function executableCandidates(root, platform, kind) {
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

export function inspectDocumentRuntimeTarget({
  vendorRoot = defaultVendorRoot,
  platform,
  arch,
  pathExists = existsSync,
}) {
  const root = path.join(vendorRoot, `${platform}-${arch}`);
  const hasExecutable = (kind) =>
    executableCandidates(root, platform, kind).some(pathExists);
  const missingRequired = [];
  if (!hasExecutable('python')) missingRequired.push('python executable');
  if (!hasExecutable('node')) missingRequired.push('node executable');
  for (const moduleName of ['docx', 'jinja2', 'markdown']) {
    if (!pathExists(path.join(root, 'python', 'site-packages', moduleName))) {
      missingRequired.push(`python site-packages/${moduleName}`);
    }
  }
  if (!hasExecutable('libreoffice'))
    missingRequired.push('LibreOffice executable');
  return {
    root,
    platform,
    arch,
    missingRequired,
    ready: missingRequired.length === 0,
  };
}

export function verifyBundledRuntimeTargets(targets, options = {}) {
  const reports = targets.map((target) =>
    inspectDocumentRuntimeTarget({ ...options, ...target }),
  );
  const failed = reports.filter((report) => !report.ready);
  for (const report of reports) {
    const label = `${report.platform}-${report.arch}`;
    if (report.ready)
      console.log(`[document-runtime] ${label}: required runtime ready`);
  }
  if (failed.length > 0) {
    throw new Error(
      failed
        .map(
          (report) =>
            `[document-runtime] ${report.platform}-${report.arch} release packaging blocked; missing: ${report.missingRequired.join(', ')}; expected root: ${report.root}`,
        )
        .join('\n'),
    );
  }
  return reports;
}

function parseTargets(argv) {
  const targets = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--target') continue;
    const value = argv[index + 1] ?? '';
    const separator = value.lastIndexOf('-');
    if (separator <= 0)
      throw new Error(`Invalid --target ${value}; expected platform-arch`);
    targets.push({
      platform: value.slice(0, separator),
      arch: value.slice(separator + 1),
    });
    index += 1;
  }
  if (targets.length === 0)
    throw new Error('At least one --target platform-arch is required');
  return targets;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    verifyBundledRuntimeTargets(parseTargets(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
