/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 内置 skill 预置：把随包分发的 8 个办公 skill（skills-seed/）拷进用户级
 * ~/.otto-user/skills/，让**任何安装（含打包的桌面 App）开箱即有 skill 可用**。
 *
 * 幂等 + 非破坏：只在目标 skill 目录不存在时复制，绝不覆盖用户已改过的 skill。
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
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));

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
 * 预置内置 skill 到 ~/.otto-user/skills/。
 * @returns 本次实际新装的 skill 名（已存在的会跳过）。
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
    const dst = join(target, name);
    if (existsSync(dst)) continue; // 已存在（用户可能改过）→ 不动
    try {
      copyDirDeep(join(seedDir, name), dst);
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
