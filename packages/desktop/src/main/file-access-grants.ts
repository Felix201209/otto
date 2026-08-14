/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 原生附件选择的最小授权账本。renderer 只能引用本轮进程中用户明确选过的文件或目录，
 * 但路径可以位于任意已挂载磁盘（含 /Volumes、Windows 其它盘符与网络盘）。
 */

import * as fs from 'node:fs';

interface FileStatLike {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
}

interface FileAccessGrantDependencies {
  realpath(value: string): string;
  stat(value: string): FileStatLike;
}

const DEFAULT_MAX_GRANTS = 256;
export type FileAccessGrantKind = 'file' | 'directory';

export interface FileAccessGrantReference {
  path: string;
  kind: FileAccessGrantKind;
}

export class FileAccessGrantStore {
  private readonly granted = new Map<string, FileAccessGrantKind>();

  constructor(
    private readonly deps: FileAccessGrantDependencies = {
      realpath: (value) => fs.realpathSync(value),
      stat: (value) => fs.statSync(value),
    },
    private readonly maxGrants = DEFAULT_MAX_GRANTS,
  ) {}

  private grantKind(paths: readonly string[], kind: FileAccessGrantKind): string[] {
    const accepted: string[] = [];
    for (const selectedPath of paths) {
      try {
        const realPath = this.deps.realpath(selectedPath);
        const metadata = this.deps.stat(realPath);
        if (
          (kind === 'file' && !metadata.isFile()) ||
          (kind === 'directory' && !metadata.isDirectory())
        ) continue;
        // Map 的插入顺序充当轻量 LRU；重复授权先删再加，延长其保留时间。
        this.granted.delete(realPath);
        this.granted.set(realPath, kind);
        accepted.push(realPath);
        while (this.granted.size > this.maxGrants) {
          const oldest = this.granted.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.granted.delete(oldest);
        }
      } catch {
        // 文件在选择后被移走、卷被卸载或权限撤回：不授予即可。
      }
    }
    return accepted;
  }

  /** 只记真实存在的普通文件；单个坏路径不影响同批其它已选文件。 */
  grant(filePaths: readonly string[]): string[] {
    return this.grantKind(filePaths, 'file');
  }

  /** 目录必须由原生选择器明确选中；只授权目录根本身，不隐式登记任意父目录。 */
  grantDirectories(directoryPaths: readonly string[]): string[] {
    return this.grantKind(directoryPaths, 'directory');
  }

  private resolveKind(
    selectedPath: string,
    kind: FileAccessGrantKind,
    maxBytes?: number,
  ): { path: string; size: number } {
    let realPath: string;
    try {
      realPath = this.deps.realpath(selectedPath);
    } catch {
      throw new Error(`${kind === 'file' ? '文件' : '目录'}路径无效或不可读`);
    }
    if (this.granted.get(realPath) !== kind) {
      throw new Error(`该${kind === 'file' ? '文件' : '目录'}未由你选择授权，请重新通过附件按钮选择`);
    }
    let stat: FileStatLike;
    try {
      stat = this.deps.stat(realPath);
    } catch {
      throw new Error(`${kind === 'file' ? '文件' : '目录'}路径无效或不可读`);
    }
    if (kind === 'directory') {
      if (!stat.isDirectory()) throw new Error('所选路径不再是目录');
      return { path: realPath, size: 0 };
    }
    if (!stat.isFile()) throw new Error('所选路径不是普通文件');
    if (maxBytes === undefined || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('文件体积上限无效');
    }
    if (stat.size > maxBytes) {
      throw new Error(`文件过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`);
    }
    return { path: realPath, size: stat.size };
  }

  /** 重新 realpath 防 symlink 换靶；授权命中后再检查普通文件与体积上限。 */
  resolve(filePath: string, maxBytes: number): { filePath: string; size: number } {
    const resolved = this.resolveKind(filePath, 'file', maxBytes);
    return { filePath: resolved.path, size: resolved.size };
  }

  /** 目录发送前再次 realpath，符号链接若在授权后换靶会因授权键不匹配而失败。 */
  resolveDirectory(directoryPath: string): string {
    return this.resolveKind(directoryPath, 'directory').path;
  }

  /**
   * 发往真实模型前批量复核 file_reference。任意一项未授权都整帧
   * fail closed，返回值只包含 realpath 后的规范路径，防止 symlink 换靶。
   */
  resolveAll(filePaths: readonly string[], maxBytes: number): string[] {
    return filePaths.map((filePath) => this.resolve(filePath, maxBytes).filePath);
  }

  /** 文件和目录按声明类型逐项复核，禁止拿目录授权冒充文件授权或反向混用。 */
  resolveReferences(
    references: readonly FileAccessGrantReference[],
    maxFileBytes: number,
  ): string[] {
    return references.map((reference) => reference.kind === 'file'
      ? this.resolve(reference.path, maxFileBytes).filePath
      : this.resolveDirectory(reference.path));
  }

  clear(): void {
    this.granted.clear();
  }
}
