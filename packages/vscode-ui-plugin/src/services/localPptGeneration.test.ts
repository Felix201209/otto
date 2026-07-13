/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from 'otto-core';
import {
  buildPptStoryboardPrompt,
  generateLocalPpt,
} from './localPptGeneration';

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
        content: '第一页：进展\n内容\n\n第二页：计划\n内容',
        format: 'slides',
        output_format: 'pptx',
        output_path: result.outputPath,
        template_options: '商务简洁',
        title: '季度 / 汇报',
      }),
      expect.any(AbortSignal),
    );
  });

  it('builds a strict storyboard contract that weaker models can follow', () => {
    const prompt = buildPptStoryboardPrompt({
      topic: '季度复盘',
      pageCount: 8,
      style: '商务克制，蓝色系',
      outline: '收入增长，退款率下降，下一季度继续优化留存。',
    });

    expect(prompt).toContain('恰好 8 页');
    expect(prompt).toContain('一页只表达一个观点');
    expect(prompt).toContain('结论句');
    expect(prompt).toContain('<!-- layout: cover -->');
    expect(prompt).toContain('statement | split | timeline | quote | list | section');
    expect(prompt).toContain('不要输出“布局建议”');
    expect(prompt).toContain('不得编造');
    expect(prompt).toContain('炫酷、高冲击');
    expect(prompt).toContain('独有视觉母题');
    expect(prompt).toContain('商务克制，蓝色系');
    expect(prompt).toContain('收入增长');
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
