/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'otto-core';
import { generateLocalPpt } from './localPptGeneration';

describe('generateLocalPpt', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-vscode-ppt-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('renders to a local pptx through the core document generator', async () => {
    const execute = vi.fn(async (params: { output_path?: string }) => {
      fs.writeFileSync(params.output_path!, 'local vscode pptx');
      return { llmContent: 'generate_document OK', returnDisplay: 'OK' };
    });

    const result = await generateLocalPpt(
      {
        topic: '季度 / 汇报',
        pageCount: 2,
        style: '商务简洁',
        outline: '第一页：进展\n内容\n\n第二页：计划\n内容',
      },
      {} as Config,
      new AbortController().signal,
      {
        outputDirectory: tempDir,
        now: () => 1234,
        createGenerator: () => ({ execute }),
      },
    );

    expect(result.outputPath).toBe(path.join(tempDir, '季度 - 汇报-1234.pptx'));
    expect(result.size).toBeGreaterThan(0);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'slides',
        output_format: 'pptx',
        output_path: result.outputPath,
        title: '季度 / 汇报',
      }),
      expect.any(AbortSignal),
    );
  });

  it('fails loudly when the renderer does not produce a file', async () => {
    await expect(generateLocalPpt(
      { topic: '失败', pageCount: 1, style: '', outline: '# 内容' },
      {} as Config,
      new AbortController().signal,
      {
        outputDirectory: tempDir,
        createGenerator: () => ({
          execute: async () => ({
            llmContent: 'generate_document FAIL: marp missing',
            returnDisplay: 'FAIL',
          }),
        }),
      },
    )).rejects.toThrow('marp missing');
  });

  it('rejects a failed render even when an older target file exists', async () => {
    const outputPath = path.join(tempDir, '旧文件-42.pptx');
    fs.writeFileSync(outputPath, 'old presentation');

    await expect(generateLocalPpt(
      { topic: '旧文件', pageCount: 1, style: '', outline: '# 内容' },
      {} as Config,
      new AbortController().signal,
      {
        outputDirectory: tempDir,
        now: () => 42,
        createGenerator: () => ({
          execute: async () => ({
            llmContent: 'generate_document FAIL: browser missing',
            returnDisplay: 'FAIL',
          }),
        }),
      },
    )).rejects.toThrow('browser missing');
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('old presentation');
  });
});
