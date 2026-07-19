/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 内置 skill 预置：把随包分发的 8 个办公 skill（skills-seed/）拷进用户级
 * ~/.otto-user/skills/，让**任何安装（含打包的桌面 App）开箱即有 skill 可用**。
 *
 * 幂等 + 非破坏：新 skill 直接复制；旧版内置 skill 仅在内容仍等于 Otto 上次预置
 * 的快照时刷新，绝不覆盖用户已改过的 skill。
 * 由 initializeSkillsContext() 在启动时调用（CLI 与桌面内嵌 server 都会经过）。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const managedStateFile = '.otto-builtin-skill.json';
const legacyUnmodifiedSkillHashes: Record<string, ReadonlySet<string>> = {
  'ppt-creator': new Set([
    '1ddbafc17534762249a5323ccd5da0d46713dfc7bda27b4aa2b70993be17a3f2',
  ]),
  'doc-writer': new Set([
    '84ed1bbb2eb0251e6e2afcebbcdc71445daca811ecb6603aad54876ada563efd',
  ]),
  'pdf-toolkit': new Set(),
  'spreadsheet-pro': new Set(),
};

function sha256File(filePath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function sha256SkillDir(skillDir: string): string | null {
  try {
    const hash = createHash('sha256');
    const visit = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (ent.name === managedStateFile) continue;
        const fullPath = join(dir, ent.name);
        const relPath = relative(skillDir, fullPath).replace(/\\/g, '/');
        if (ent.isDirectory()) {
          hash.update(`dir:${relPath}\0`);
          visit(fullPath);
        } else {
          hash.update(`file:${relPath}\0`);
          hash.update(readFileSync(fullPath));
          hash.update('\0');
        }
      }
    };
    visit(skillDir);
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function readManagedHash(skillDir: string): string | undefined {
  try {
    const state = JSON.parse(readFileSync(join(skillDir, managedStateFile), 'utf8')) as {
      sourceHash?: unknown;
    };
    return typeof state.sourceHash === 'string' ? state.sourceHash : undefined;
  } catch {
    return undefined;
  }
}

function writeManagedHash(skillDir: string, sourceHash: string): void {
  writeFileSync(
    join(skillDir, managedStateFile),
    JSON.stringify({ sourceHash }, null, 2) + '\n',
    'utf8',
  );
}

/** 只刷新 Otto 自己管理且用户未修改的内置 skill。 */
export function shouldRefreshBuiltinSkill(
  name: string,
  currentHash: string,
  sourceHash: string,
  managedHash?: string,
  legacyCurrentHash?: string,
): boolean {
  if (currentHash === sourceHash) return false;
  if (managedHash && managedHash === currentHash) return true;
  const legacyHashes = legacyUnmodifiedSkillHashes[name];
  return legacyHashes?.has(currentHash)
    || (legacyCurrentHash ? legacyHashes?.has(legacyCurrentHash) : false)
    || false;
}

/**
 * 手写递归复制——不用 fs.cpSync：打包后 skills-seed 在 app.asar 内，cpSync 的原生递归
 * 实现可能绕过 Electron 对 asar 的 fs 补丁而读不到；readdir/readFileSync/writeFileSync
 * 都走补丁、从 asar 读没问题。
 */
function copyDirDeep(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dst, ent.name);
    if (ent.isDirectory()) copyDirDeep(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

/** 定位随包的 skills-seed/ 目录（兼容 dev 的 src 布局与打包后的 dist 布局）。 */
function findSeedDir(): string | null {
  const candidates = [
    resolve(moduleDir, '../../../skills-seed'), // dist/src/skills → 包根
    resolve(moduleDir, '../../skills-seed'), // src/skills → packages/core（dev）
    resolve(moduleDir, '../../../../skills-seed'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * 直接读取随安装包分发的内置 Skill 正文。
 *
 * 专家 profile 可用它把强制工作流直接放进 system context，而不是把可靠性
 * 交给模型是否记得再次调用 use_skill。只允许简单目录名，避免路径穿越。
 */
export function loadBuiltinSkillInstructions(name: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) return undefined;
  const seedDir = findSeedDir();
  if (!seedDir) return undefined;
  try {
    return readFileSync(join(seedDir, name, 'SKILL.md'), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * 预置内置 skill 到 ~/.otto-user/skills/。
 * @returns 本次实际新装或安全刷新的 skill 名。
 */
export function seedDefaultSkills(): string[] {
  const seedDir = findSeedDir();
  if (!seedDir) return [];

  const target = join(homedir(), '.otto-user', 'skills');
  const seeded: string[] = [];

  let names: string[];
  try {
    names = readdirSync(seedDir).filter((n) => {
      try {
        return statSync(join(seedDir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  for (const name of names) {
    const src = join(seedDir, name);
    const dst = join(target, name);
    const sourceHash = sha256SkillDir(src);
    if (existsSync(dst)) {
      const currentHash = sha256SkillDir(dst);
      if (!sourceHash || !currentHash) continue;
      if (currentHash === sourceHash) {
        try { writeManagedHash(dst, sourceHash); } catch { /* best effort */ }
        continue;
      }
      if (!shouldRefreshBuiltinSkill(
        name,
        currentHash,
        sourceHash,
        readManagedHash(dst),
        sha256File(join(dst, 'SKILL.md')) ?? undefined,
      )) continue;
    }
    try {
      copyDirDeep(src, dst);
      if (sourceHash) writeManagedHash(dst, sourceHash);
      seeded.push(name);
    } catch {
      // 单个失败不影响其它
    }
  }

  if (seeded.length > 0) {
    console.log(`[skills] 预置内置 skill：${seeded.join(', ')}`);
  }
  return seeded;
}
