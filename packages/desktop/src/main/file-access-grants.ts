/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 原生文件选择的最小授权账本。renderer 只能读取本轮进程中用户明确选过的文件，
 * 但文件可以位于任意已挂载磁盘（含 /Volumes、Windows 其它盘符与网络盘）。
 */

import * as fs from 'node:fs';

interface FileStatLike {
  isFile(): boolean;
  size: number;
}

interface FileAccessGrantDependencies {
  realpath(value: string): string;
  stat(value: string): FileStatLike;
}

const DEFAULT_MAX_GRANTS = 256;

export class FileAccessGrantStore {
  private readonly granted = new Set<string>();

  constructor(
    private readonly deps: FileAccessGrantDependencies = {
      realpath: (value) => fs.realpathSync(value),
      stat: (value) => fs.statSync(value),
    },
    private readonly maxGrants = DEFAULT_MAX_GRANTS,
  ) {}

  /** 只记真实存在的普通文件；单个坏路径不影响同批其它已选文件。 */
  grant(filePaths: readonly string[]): string[] {
    const accepted: string[] = [];
    for (const filePath of filePaths) {
      try {
        const realPath = this.deps.realpath(filePath);
        if (!this.deps.stat(realPath).isFile()) continue;
        // Set 的插入顺序充当轻量 LRU；重复授权先删再加，延长其保留时间。
        this.granted.delete(realPath);
        this.granted.add(realPath);
        accepted.push(realPath);
        while (this.granted.size > this.maxGrants) {
          const oldest = this.granted.values().next().value as string | undefined;
          if (oldest === undefined) break;
          this.granted.delete(oldest);
        }
      } catch {
        // 文件在选择后被移走、卷被卸载或权限撤回：不授予即可。
      }
    }
    return accepted;
  }

  /** 重新 realpath 防 symlink 换靶；授权命中后再检查普通文件与体积上限。 */
  resolve(filePath: string, maxBytes: number): { filePath: string; size: number } {
    let realPath: string;
    try {
      realPath = this.deps.realpath(filePath);
    } catch {
      throw new Error('文件路径无效或不可读');
    }
    if (!this.granted.has(realPath)) {
      throw new Error('该文件未由你选择授权，请重新通过附件按钮选择');
    }
    let stat: FileStatLike;
    try {
      stat = this.deps.stat(realPath);
    } catch {
      throw new Error('文件路径无效或不可读');
    }
    if (!stat.isFile()) throw new Error('所选路径不是普通文件');
    if (stat.size > maxBytes) {
      throw new Error(`文件过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
    }
    return { filePath: realPath, size: stat.size };
  }

  /**
   * 发往真实模型前批量复核 file_reference。任意一项未授权都整帧
   * fail closed，返回值只包含 realpath 后的规范路径，防止 symlink 换靶。
   */
  resolveAll(filePaths: readonly string[], maxBytes: number): string[] {
    return filePaths.map((filePath) => this.resolve(filePath, maxBytes).filePath);
  }

  clear(): void {
    this.granted.clear();
  }
}
