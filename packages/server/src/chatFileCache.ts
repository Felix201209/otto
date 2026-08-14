/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessageContent } from './protocol.js';

export interface CacheChatFilesOptions {
  baseDir?: string;
  maxDirectoryEntries?: number;
  maxDirectoryBytes?: number;
  maxDirectoryDepth?: number;
}

export interface CacheChatFilesResult {
  content: MessageContent;
  cachedFiles: number;
}

function defaultChatFileCacheDir(): string {
  return path.join(os.homedir(), '.otto-user', 'chat-files');
}

function safeFileName(fileName: string): string {
  const base = path.basename(fileName).replace(/[^\w .@()+,-]/g, '_').trim();
  return base || 'attachment';
}

function cachePathForFile(baseDir: string, sessionId: string, fileName: string): string {
  const id = randomBytes(8).toString('hex');
  return path.join(baseDir, sessionId, `${id}-${safeFileName(fileName)}`);
}

export const DEFAULT_CHAT_DIRECTORY_MAX_ENTRIES = 1_000;
export const DEFAULT_CHAT_DIRECTORY_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_CHAT_DIRECTORY_MAX_DEPTH = 20;

interface DirectorySnapshotBudget {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  maxDepth: number;
}

interface DirectorySnapshotEntry {
  kind: 'file' | 'directory';
  sourcePath: string;
  relativePath: string;
  size: number;
}

function positiveSafeInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label}必须是正整数`);
  }
  return resolved;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function collectDirectorySnapshot(
  sourceRoot: string,
  budget: DirectorySnapshotBudget,
): Promise<{ root: string; entries: DirectorySnapshotEntry[] }> {
  const rootMetadata = await fs.lstat(sourceRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error('目录附件必须是真实目录，不能是符号链接');
  }
  const canonicalRoot = await fs.realpath(sourceRoot);
  const entries: DirectorySnapshotEntry[] = [];

  const visit = async (current: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > budget.maxDepth) {
      throw new Error(`目录附件嵌套深度超过 ${budget.maxDepth} 层`);
    }
    const children = await fs.readdir(current, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      budget.entries += 1;
      if (budget.entries > budget.maxEntries) {
        throw new Error(`目录附件条目数超过 ${budget.maxEntries} 个`);
      }
      const sourcePath = path.join(current, child.name);
      const relativePath = path.join(relativeDirectory, child.name);
      const metadata = await fs.lstat(sourcePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`目录附件包含符号链接：${relativePath}`);
      }
      const canonicalPath = await fs.realpath(sourcePath);
      if (!isWithinRoot(canonicalPath, canonicalRoot)) {
        throw new Error(`目录附件条目越出授权根目录：${relativePath}`);
      }
      if (metadata.isDirectory()) {
        entries.push({ kind: 'directory', sourcePath: canonicalPath, relativePath, size: 0 });
        await visit(canonicalPath, relativePath, depth + 1);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`目录附件包含不支持的特殊文件：${relativePath}`);
      }
      budget.bytes += metadata.size;
      if (!Number.isSafeInteger(budget.bytes) || budget.bytes > budget.maxBytes) {
        throw new Error(`目录附件总容量超过 ${Math.round(budget.maxBytes / 1024 / 1024)}MB`);
      }
      entries.push({
        kind: 'file',
        sourcePath: canonicalPath,
        relativePath,
        size: metadata.size,
      });
    }
  };

  await visit(canonicalRoot, '', 0);
  return { root: canonicalRoot, entries };
}

async function copySnapshotFile(entry: DirectorySnapshotEntry, targetPath: string): Promise<void> {
  const metadata = await fs.lstat(entry.sourcePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`目录附件在快照期间发生变化：${entry.relativePath}`);
  }
  const openFlags = fsConstants.O_RDONLY |
    (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW);
  const source = await fs.open(entry.sourcePath, openFlags);
  let target: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const openedMetadata = await source.stat();
    if (!openedMetadata.isFile() || openedMetadata.size !== entry.size) {
      throw new Error(`目录附件在快照期间发生变化：${entry.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    target = await fs.open(targetPath, 'wx');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let copied = 0;
    while (copied < entry.size) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, entry.size - copied),
        null,
      );
      if (bytesRead === 0) {
        throw new Error(`目录附件在快照期间被截断：${entry.relativePath}`);
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, null);
        if (result.bytesWritten === 0) {
          throw new Error(`目录附件快照目标停止接收数据：${entry.relativePath}`);
        }
        written += result.bytesWritten;
      }
      copied += bytesRead;
    }
    const extra = await source.read(buffer, 0, 1, null);
    if (extra.bytesRead !== 0) {
      throw new Error(`目录附件在快照期间增长：${entry.relativePath}`);
    }
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function snapshotDirectory(
  sourcePath: string,
  targetPath: string,
  budget: DirectorySnapshotBudget,
): Promise<number> {
  const plan = await collectDirectorySnapshot(sourcePath, budget);
  const temporaryPath = `${targetPath}.partial-${randomBytes(6).toString('hex')}`;
  try {
    await fs.mkdir(temporaryPath, { recursive: false });
    for (const entry of plan.entries) {
      const destination = path.join(temporaryPath, entry.relativePath);
      if (!isWithinRoot(destination, temporaryPath)) {
        throw new Error(`目录附件快照路径无效：${entry.relativePath}`);
      }
      if (entry.kind === 'directory') {
        await fs.mkdir(destination, { recursive: false });
      } else {
        await copySnapshotFile(entry, destination);
      }
    }
    await fs.rename(temporaryPath, targetPath);
    return plan.entries.filter((entry) => entry.kind === 'file').length;
  } catch (error) {
    await fs.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function cacheChatFiles(
  sessionId: string,
  content: MessageContent,
  options: CacheChatFilesOptions = {},
): Promise<CacheChatFilesResult> {
  const baseDir = options.baseDir ?? defaultChatFileCacheDir();
  const directoryBudget: DirectorySnapshotBudget = {
    entries: 0,
    bytes: 0,
    maxEntries: positiveSafeInteger(
      options.maxDirectoryEntries,
      DEFAULT_CHAT_DIRECTORY_MAX_ENTRIES,
      '目录附件条目上限',
    ),
    maxBytes: positiveSafeInteger(
      options.maxDirectoryBytes,
      DEFAULT_CHAT_DIRECTORY_MAX_BYTES,
      '目录附件容量上限',
    ),
    maxDepth: positiveSafeInteger(
      options.maxDirectoryDepth,
      DEFAULT_CHAT_DIRECTORY_MAX_DEPTH,
      '目录附件深度上限',
    ),
  };
  let cachedFiles = 0;
  let changed = false;
  const createdPaths: string[] = [];

  const rewritten: MessageContent = [];
  try {
    for (const part of content) {
      if (part.type === 'folder_reference') {
        const sourcePath = part.value.folderPath;
        if (!path.isAbsolute(sourcePath)) {
          throw new Error(`目录附件路径必须是绝对路径：${part.value.folderName}`);
        }
        const targetPath = cachePathForFile(baseDir, sessionId, part.value.folderName);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        cachedFiles += await snapshotDirectory(sourcePath, targetPath, directoryBudget);
        createdPaths.push(targetPath);
        rewritten.push({
          type: 'folder_reference',
          value: { ...part.value, folderPath: targetPath },
        });
        changed = true;
        continue;
      }
      if (part.type !== 'file_reference') {
        rewritten.push(part);
        continue;
      }

      const sourcePath = part.value.filePath;
      if (!path.isAbsolute(sourcePath)) {
        throw new Error(`附件路径必须是绝对路径：${part.value.fileName}`);
      }

      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        throw new Error(`附件不是普通文件：${part.value.fileName}`);
      }

      const targetPath = cachePathForFile(baseDir, sessionId, part.value.fileName);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
      createdPaths.push(targetPath);

      rewritten.push({
        type: 'file_reference',
        value: {
          ...part.value,
          filePath: targetPath,
        },
      });
      cachedFiles++;
      changed = true;
    }
  } catch (error) {
    await Promise.all(
      createdPaths.map((createdPath) =>
        fs.rm(createdPath, { recursive: true, force: true }).catch(() => undefined)),
    );
    throw error;
  }

  return {
    content: changed ? rewritten : content,
    cachedFiles,
  };
}
