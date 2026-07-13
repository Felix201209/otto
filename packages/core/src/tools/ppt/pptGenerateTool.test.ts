/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createMockConfig } from '../../utils/test-helpers.js';
import {
  GenerateDocumentTool,
  type HtmlToImageRenderer,
} from '../generate-document.js';
import { PPTOutlineManager } from './pptOutlineManager.js';
import { PptGenerateTool } from './pptGenerateTool.js';

describe('PptGenerateTool local rendering', () => {
  let tempDir: string;
  let originalServerUrl: string | undefined;
  let originalWebUrl: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-ppt-local-'));
    originalServerUrl = process.env.OTTO_SERVER_URL;
    originalWebUrl = process.env.OTTO_WEB_URL;
    delete process.env.OTTO_SERVER_URL;
    delete process.env.OTTO_WEB_URL;
    PPTOutlineManager.getInstance().clear();

  });

  afterEach(() => {
    PPTOutlineManager.getInstance().clear();
    if (originalServerUrl === undefined) delete process.env.OTTO_SERVER_URL;
    else process.env.OTTO_SERVER_URL = originalServerUrl;
    if (originalWebUrl === undefined) delete process.env.OTTO_WEB_URL;
    else process.env.OTTO_WEB_URL = originalWebUrl;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('renders a pptx locally without OTTO server or web URLs', async () => {
    const outputPath = path.join(tempDir, 'local-deck.pptx');
    const manager = PPTOutlineManager.getInstance();
    manager.init('本地演示');
    manager.update({
      pageCount: 2,
      outline: '# 第一页\n\n本地内容\n\n---\n\n# 第二页\n\n仍然只在本机',
    });

    const config = createMockConfig();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp0aNwAAAABJRU5ErkJggg==',
      'base64',
    );
    const htmlRenderer: HtmlToImageRenderer = {
      render: async ({ outputPath }) => fs.writeFileSync(outputPath, png),
    };
    const tool = new PptGenerateTool(
      config,
      new GenerateDocumentTool(config, htmlRenderer),
    );
    const result = await tool.execute(
      { output_path: outputPath },
      new AbortController().signal,
    );

    const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    expect(zip.file('ppt/slides/slide1.xml')).not.toBeNull();
    expect(zip.file('ppt/slides/slide2.xml')).not.toBeNull();
    expect(result.llmContent).toContain('PPT 已在本地生成');
    expect(result.llmContent).toContain(outputPath);
    expect(result.llmContent).not.toContain('OTTO_WEB_URL');
    expect(result.llmContent).not.toContain('服务端');
    expect(manager.isActive()).toBe(false);
  });

  it('describes a local file operation in its confirmation', async () => {
    const outputPath = path.join(tempDir, 'confirm.pptx');
    const manager = PPTOutlineManager.getInstance();
    manager.init('确认本地生成');
    manager.update({ outline: '# 唯一一页' });

    const tool = new PptGenerateTool(createMockConfig());
    const confirmation = await tool.shouldConfirmExecute(
      { output_path: outputPath },
      new AbortController().signal,
    );

    expect(confirmation).not.toBe(false);
    if (confirmation !== false) {
      expect(confirmation.prompt).toContain('本地');
      expect(confirmation.prompt).toContain(outputPath);
      expect(confirmation.prompt).not.toContain('服务端');
      expect(confirmation.prompt).toContain('本机浏览器');
      expect(confirmation.prompt).not.toContain('OTTO_WEB_URL');
    }
  });

  it('reports the requested output as a tool location', () => {
    const outputPath = path.join(tempDir, 'location.pptx');
    const tool = new PptGenerateTool(createMockConfig());
    expect(tool.toolLocations({ output_path: outputPath })).toEqual([
      { path: outputPath },
    ]);
  });

  it('does not treat a stale output file as a successful render', async () => {
    const outputPath = path.join(tempDir, 'stale.pptx');
    fs.writeFileSync(outputPath, 'old presentation');
    const manager = PPTOutlineManager.getInstance();
    manager.init('失败后保留大纲');
    manager.update({ outline: '# 内容' });
    const failingGenerator = {
      execute: async () => ({
        llmContent: 'generate_document FAIL: browser missing',
        returnDisplay: 'generate_document FAIL: browser missing',
      }),
    } as unknown as GenerateDocumentTool;

    const result = await new PptGenerateTool(
      createMockConfig(),
      failingGenerator,
    ).execute({ output_path: outputPath }, new AbortController().signal);

    expect(result.llmContent).toContain('本地 PPT 生成失败');
    expect(manager.isActive()).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('old presentation');
  });
});
