/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cacheChatFiles } from './chatFileCache.js';
import type { MessageContent } from './protocol.js';

describe('cacheChatFiles', () => {
  it('copies file references into the server cache and rewrites filePath', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-chat-cache-'));
    const sourcePath = path.join(root, 'report.md');
    const cacheDir = path.join(root, 'cache');
    await fs.writeFile(sourcePath, 'hello cache', 'utf8');

    const content: MessageContent = [
      { type: 'text', value: 'read this' },
      {
        type: 'file_reference',
        value: { fileName: 'report.md', filePath: sourcePath },
      },
    ];

    const result = await cacheChatFiles('session-1', content, { baseDir: cacheDir });

    expect(result.cachedFiles).toBe(1);
    expect(result.content[0]).toBe(content[0]);
    const filePart = result.content[1];
    if (filePart.type !== 'file_reference') throw new Error('unreachable');
    expect(filePart.value.filePath).not.toBe(sourcePath);
    expect(filePart.value.filePath.startsWith(path.join(cacheDir, 'session-1'))).toBe(true);
    await expect(fs.readFile(filePart.value.filePath, 'utf8')).resolves.toBe('hello cache');
  });

  it('fails loudly when a referenced file is missing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-chat-cache-'));
    await expect(
      cacheChatFiles(
        'session-1',
        [
          {
            type: 'file_reference',
            value: { fileName: 'missing.txt', filePath: path.join(root, 'missing.txt') },
          },
        ],
        { baseDir: path.join(root, 'cache') },
      ),
    ).rejects.toThrow(/ENOENT/);
  });

  it('rejects relative file paths before caching', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-chat-cache-'));
    await expect(
      cacheChatFiles(
        'session-1',
        [
          {
            type: 'file_reference',
            value: { fileName: 'relative.txt', filePath: 'relative.txt' },
          },
        ],
        { baseDir: path.join(root, 'cache') },
      ),
    ).rejects.toThrow('附件路径必须是绝对路径');
  });
});
