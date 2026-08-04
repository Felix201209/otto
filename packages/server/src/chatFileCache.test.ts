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

  it('snapshots directory references and rewrites history to the session cache', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-chat-cache-'));
    const sourcePath = path.join(root, 'workspace');
    const cacheDir = path.join(root, 'cache');
    await fs.mkdir(path.join(sourcePath, 'docs'), { recursive: true });
    await fs.mkdir(path.join(sourcePath, 'empty'));
    await fs.writeFile(path.join(sourcePath, 'README.md'), 'root file', 'utf8');
    await fs.writeFile(path.join(sourcePath, 'docs', 'plan.md'), 'nested file', 'utf8');

    const result = await cacheChatFiles(
      'session-folder',
      [{
        type: 'folder_reference',
        value: { folderName: 'workspace', folderPath: sourcePath },
      }],
      { baseDir: cacheDir },
    );

    expect(result.cachedFiles).toBe(2);
    const folderPart = result.content[0];
    if (folderPart.type !== 'folder_reference') throw new Error('unreachable');
    expect(folderPart.value.folderPath).not.toBe(sourcePath);
    expect(folderPart.value.folderPath.startsWith(path.join(cacheDir, 'session-folder'))).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain(sourcePath);
    await expect(
      fs.readFile(path.join(folderPart.value.folderPath, 'docs', 'plan.md'), 'utf8'),
    ).resolves.toBe('nested file');
    expect((await fs.stat(path.join(folderPart.value.folderPath, 'empty'))).isDirectory()).toBe(
      true,
    );
  });

  it('rejects symbolic links anywhere below a directory attachment', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-chat-cache-'));
    const sourcePath = path.join(root, 'workspace');
    const outsidePath = path.join(root, 'outside');
    const cacheDir = path.join(root, 'cache');
    await fs.mkdir(sourcePath);
    await fs.mkdir(outsidePath);
    await fs.writeFile(path.join(outsidePath, 'secret.txt'), 'secret', 'utf8');
    await fs.symlink(
      outsidePath,
      path.join(sourcePath, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      cacheChatFiles(
        'session-link',
        [{
          type: 'folder_reference',
          value: { folderName: 'workspace', folderPath: sourcePath },
        }],
        { baseDir: cacheDir },
      ),
    ).rejects.toThrow('目录附件包含符号链接');
    await expect(fs.readdir(path.join(cacheDir, 'session-link'))).resolves.toEqual([]);
  });

  it('enforces aggregate directory limits and rolls back earlier snapshots', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-chat-cache-'));
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    const cacheDir = path.join(root, 'cache');
    await fs.mkdir(first);
    await fs.mkdir(second);
    await fs.writeFile(path.join(first, 'one.txt'), '123', 'utf8');
    await fs.writeFile(path.join(second, 'two.txt'), '456', 'utf8');

    await expect(
      cacheChatFiles(
        'session-limit',
        [
          { type: 'folder_reference', value: { folderName: 'first', folderPath: first } },
          { type: 'folder_reference', value: { folderName: 'second', folderPath: second } },
        ],
        { baseDir: cacheDir, maxDirectoryBytes: 5 },
      ),
    ).rejects.toThrow('目录附件总容量超过');
    await expect(fs.readdir(path.join(cacheDir, 'session-limit'))).resolves.toEqual([]);
  });

  it('rejects directory trees deeper than the configured limit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-chat-cache-'));
    const sourcePath = path.join(root, 'workspace');
    await fs.mkdir(path.join(sourcePath, 'one', 'two'), { recursive: true });

    await expect(
      cacheChatFiles(
        'session-depth',
        [{
          type: 'folder_reference',
          value: { folderName: 'workspace', folderPath: sourcePath },
        }],
        { baseDir: path.join(root, 'cache'), maxDirectoryDepth: 1 },
      ),
    ).rejects.toThrow('目录附件嵌套深度超过 1 层');
  });
});
