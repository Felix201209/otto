/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoMemoryEngine } from './autoMerge.js';
import {
  atomicWriteTextFile,
  deduplicateGlobalMemoryContent,
  type AtomicTextWriteOperations,
} from './globalMemoryMaintenance.js';
import { MemoryTool } from '../tools/memoryTool.js';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'otto-memory-maintenance-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('deduplicateGlobalMemoryContent', () => {
  it('removes only later duplicate facts and preserves prose, headings and comments', () => {
    const input = [
      '# User context',
      '',
      '## Otto Added Memories',
      'This paragraph explains the following facts.',
      '',
      '### Preferences',
      '- concise replies',
      '<!-- keep this maintenance note -->',
      '  - use pnpm  ',
      '- concise replies',
      '---',
      '',
      '## Other Section',
      '- concise replies',
      '',
    ].join('\n');

    const result = deduplicateGlobalMemoryContent(input);

    expect(result).toMatchObject({ before: 3, after: 2, removed: 1 });
    expect(result.content).toBe(
      [
        '# User context',
        '',
        '## Otto Added Memories',
        'This paragraph explains the following facts.',
        '',
        '### Preferences',
        '- concise replies',
        '<!-- keep this maintenance note -->',
        '  - use pnpm  ',
        '---',
        '',
        '## Other Section',
        '- concise replies',
        '',
      ].join('\n'),
    );
  });

  it('preserves CRLF and returns the original string when no duplicate exists', () => {
    const input =
      '## Otto Added Memories\r\n- first\r\nParagraph\r\n- second\r\n';

    const result = deduplicateGlobalMemoryContent(input);

    expect(result).toEqual({
      content: input,
      before: 2,
      after: 2,
      removed: 0,
    });
  });

  it('does not treat horizontal rules or malformed empty bullets as facts', () => {
    const input = '## Otto Added Memories\n---\n-   \n---\n## Other\n- fact\n';

    expect(deduplicateGlobalMemoryContent(input)).toEqual({
      content: input,
      before: 0,
      after: 0,
      removed: 0,
    });
  });
});

describe('atomicWriteTextFile', () => {
  it('fsyncs before rename and leaves the destination untouched when rename fails', async () => {
    const calls: string[] = [];
    const destination = 'original';
    let temporary = '';
    const operations: AtomicTextWriteOperations = {
      stat: vi.fn(async () => ({ mode: 0o100640 })),
      open: vi.fn(async () => ({
        writeFile: async (data) => {
          calls.push('write');
          temporary = data;
        },
        sync: async () => {
          calls.push('sync');
        },
        close: async () => {
          calls.push('close');
        },
      })),
      rename: vi.fn(async () => {
        calls.push('rename');
        throw new Error('simulated rename failure');
      }),
      unlink: vi.fn(async () => {
        calls.push('unlink');
        temporary = '';
      }),
    };

    await expect(
      atomicWriteTextFile('C:\\memory\\global.md', 'replacement', operations),
    ).rejects.toThrow('simulated rename failure');

    expect(destination).toBe('original');
    expect(temporary).toBe('');
    expect(calls).toEqual(['write', 'sync', 'close', 'rename', 'unlink']);
  });
});

describe('AutoMemoryEngine global.md maintenance', () => {
  it('atomically deduplicates the target section without leaving temporary files', async () => {
    const directory = await makeTemporaryDirectory();
    const globalMdPath = path.join(directory, 'global.md');
    await fs.writeFile(
      globalMdPath,
      '## Otto Added Memories\nIntro\n- same\n<!-- note -->\n- same\n',
      'utf8',
    );
    const engine = new AutoMemoryEngine({
      storageDir: directory,
      knowledgeDir: directory,
      globalMdPath,
      knowledgeJsonlPath: path.join(directory, 'entries.jsonl'),
    });

    await expect(engine.deduplicateGlobalMd()).resolves.toEqual({
      before: 2,
      after: 1,
      removed: 1,
    });
    await expect(fs.readFile(globalMdPath, 'utf8')).resolves.toBe(
      '## Otto Added Memories\nIntro\n- same\n<!-- note -->\n',
    );
    const names = await fs.readdir(directory);
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('serializes save_memory and maintenance so a new fact is not lost', async () => {
    const directory = await makeTemporaryDirectory();
    const globalMdPath = path.join(directory, 'global.md');
    await fs.writeFile(
      globalMdPath,
      '## Otto Added Memories\n- duplicate\n- duplicate\n',
      'utf8',
    );
    const engine = new AutoMemoryEngine({
      storageDir: directory,
      knowledgeDir: directory,
      globalMdPath,
      knowledgeJsonlPath: path.join(directory, 'entries.jsonl'),
    });

    let releaseWrite!: () => void;
    const mayWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writeStarted!: () => void;
    const didStartWrite = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const savePromise = MemoryTool.performAddMemoryEntry(
      'new fact',
      globalMdPath,
      {
        readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
        mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
        writeFile: async (filePath, content, encoding) => {
          writeStarted();
          await mayWrite;
          await fs.writeFile(filePath, content, encoding);
        },
      },
    );
    await didStartWrite;

    const maintenancePromise = engine.deduplicateGlobalMd();
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseWrite();
    await Promise.all([savePromise, maintenancePromise]);

    await expect(fs.readFile(globalMdPath, 'utf8')).resolves.toBe(
      '## Otto Added Memories\n- duplicate\n- new fact\n',
    );
  });
});
