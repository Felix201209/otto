/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MessageContent } from './protocol.js';

export interface CacheChatFilesOptions {
  baseDir?: string;
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

export async function cacheChatFiles(
  sessionId: string,
  content: MessageContent,
  options: CacheChatFilesOptions = {},
): Promise<CacheChatFilesResult> {
  const baseDir = options.baseDir ?? defaultChatFileCacheDir();
  let cachedFiles = 0;
  let changed = false;

  const rewritten: MessageContent = [];
  for (const part of content) {
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

  return {
    content: changed ? rewritten : content,
    cachedFiles,
  };
}
