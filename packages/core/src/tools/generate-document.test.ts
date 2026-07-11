/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import {
  ChromeHtmlToImageRenderer,
  findLocalBrowserExecutable,
  GenerateDocumentTool,
  type HtmlToImageRenderer,
  normalizeSlidesMarkdown,
} from './generate-document.js';
import { createMockConfig } from '../utils/test-helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';

function hasBin(name: string): boolean {
  try { execSync('command -v ' + name, { stdio: 'ignore' }); return true; } catch { return false; }
}

describe('GenerateDocumentTool', () => {
  let tool: GenerateDocumentTool;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new GenerateDocumentTool(createMockConfig());
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-test-gen-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // 临时目录清理是尽力而为。
    }
  });

  // --- Metadata ---
  it('has correct name', () => { expect(GenerateDocumentTool.Name).toBe('generate_document'); });
  it('has display name', () => { expect(tool.displayName).toBe('GenerateDocument'); });
  it('has Pencil icon', () => { expect(tool.icon).toBe('pencil'); });

  // --- Validation ---
  it('rejects empty content', () => {
    expect(tool.validateToolParams({ content: '', format: 'report', output_format: 'pdf' })).toContain('content');
  });
  it('rejects slides with docx output', () => {
    expect(tool.validateToolParams({ content: '# Hi', format: 'slides', output_format: 'docx' })).toContain('slides');
  });
  it('accepts slides with pptx output', () => {
    expect(tool.validateToolParams({ content: '# Hi\n---\n# Page 2', format: 'slides', output_format: 'pptx' })).toBeNull();
  });
  it('accepts report with pdf', () => {
    expect(tool.validateToolParams({ content: '# Report\nContent', format: 'report', output_format: 'pdf' })).toBeNull();
  });
  it('accepts letter with html', () => {
    expect(tool.validateToolParams({ content: 'Dear...', format: 'letter', output_format: 'html' })).toBeNull();
  });
  it('accepts resume with markdown', () => {
    expect(tool.validateToolParams({ content: '## Skills', format: 'resume', output_format: 'markdown' })).toBeNull();
  });

  // --- getDescription ---
  it('getDescription includes format and output', () => {
    expect(tool.getDescription({ content: 'x', format: 'report', output_format: 'pdf' })).toContain('report');
  });

  // --- shouldConfirmExecute ---
  it('shouldConfirmExecute returns confirmation in DEFAULT mode', async () => {
    const r = await tool.shouldConfirmExecute(
      { content: '# Hi', format: 'report', output_format: 'pdf' },
      new AbortController().signal,
    );
    expect(r).not.toBe(false);
  });

  // --- markdown output needs no external tool (pure fs write) ---
  it('markdown output writes a file with zero dependencies', async () => {
    const out = path.join(tmpDir, 'doc.md');
    const r = await tool.execute(
      { content: '# Hello\n\nWorld', format: 'article', output_format: 'markdown', title: 'T', output_path: out },
      new AbortController().signal,
    );
    expect(r.llmContent).toContain('generate_document OK');
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toContain('# T');
  });

  // --- Doctor preflight: engine binaries checked BEFORE rendering ---
  const typstAvailable = hasBin('typst');
  const marpAvailable = hasBin('marp') || hasBin('marp-cli');
  const pandocAvailable = hasBin('pandoc');

  it.runIf(!typstAvailable)('report->pdf fails loud with typst install command when typst is missing', async () => {
    const out = path.join(tmpDir, 'r.pdf');
    const r = await tool.execute(
      { content: '# Report\n\nBody', format: 'report', output_format: 'pdf', title: 'R', output_path: out },
      new AbortController().signal,
    );
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('typst');
    expect(r.llmContent).toContain('brew install typst');
  });

  it('slides->pptx renders local HTML to images before packaging OOXML', async () => {
    const out = path.join(tmpDir, 's.pptx');
    const renderedHtml: string[] = [];
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp0aNwAAAABJRU5ErkJggg==',
      'base64',
    );
    const htmlRenderer: HtmlToImageRenderer = {
      render: vi.fn(async ({ htmlPath, outputPath }) => {
        renderedHtml.push(fs.readFileSync(htmlPath, 'utf8'));
        fs.writeFileSync(outputPath, onePixelPng);
      }),
    };
    const htmlTool = new GenerateDocumentTool(createMockConfig(), htmlRenderer);
    const r = await htmlTool.execute(
      { content: '# Slide 1\n\n- Point A\n\n---\n\n# Slide 2\n\nPoint B', format: 'slides', output_format: 'pptx', title: 'S', output_path: out },
      new AbortController().signal,
    );

    expect(r.llmContent).toContain('generate_document OK');
    expect(htmlRenderer.render).toHaveBeenCalledTimes(2);
    expect(renderedHtml[0]).toContain('<!doctype html>');
    expect(renderedHtml[0]).toContain('data-slide-index="1"');
    expect(renderedHtml[0]).toContain('<li>Point A</li>');
    expect(renderedHtml[1]).toContain('Slide 2');

    const zip = await JSZip.loadAsync(fs.readFileSync(out));
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    const mediaFiles = Object.keys(zip.files).filter((name) => name.startsWith('ppt/media/'));
    expect(mediaFiles.length).toBeGreaterThanOrEqual(1);
    const firstSlideXml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const secondSlideXml = await zip.file('ppt/slides/slide2.xml')!.async('string');
    expect(firstSlideXml).toContain('<p:pic>');
    expect(secondSlideXml).toContain('<p:pic>');
    expect(firstSlideXml).not.toContain('<a:t>Slide 1</a:t>');
    expect(firstSlideXml).not.toContain('<p:sp>');
  });

  it.runIf(!marpAvailable)('slides->pdf fails loud with marp install command when marp is missing', async () => {
    const out = path.join(tmpDir, 's.pdf');
    const r = await tool.execute(
      { content: '# Slide 1\n---\n# Slide 2', format: 'slides', output_format: 'pdf', title: 'S', output_path: out },
      new AbortController().signal,
    );
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('marp');
    expect(r.llmContent).toContain('@marp-team/marp-cli');
  });

  it.runIf(!pandocAvailable)('article->docx fails loud with pandoc install command when pandoc is missing', async () => {
    const out = path.join(tmpDir, 'a.docx');
    const r = await tool.execute(
      { content: '# Article\n\nText', format: 'article', output_format: 'docx', title: 'A', output_path: out },
      new AbortController().signal,
    );
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('pandoc');
    expect(r.llmContent).toContain('brew install pandoc');
  });
});

describe('normalizeSlidesMarkdown', () => {
  it('keeps explicit Marp slide separators unchanged', () => {
    const markdown = '# One\n\n---\n\n# Two';
    expect(normalizeSlidesMarkdown(markdown)).toBe(markdown);
  });

  it('drops a redundant leading separator because the tool adds front matter', () => {
    expect(normalizeSlidesMarkdown('---\n# One\n\n---\n\n# Two'))
      .toBe('# One\n\n---\n\n# Two');
  });

  it('turns Chinese page headings into separate local slides', () => {
    expect(normalizeSlidesMarkdown(
      '第一页：开场\n要点 A\n\n第二页：结论\n要点 B',
    )).toBe('# 开场\n要点 A\n\n---\n\n# 结论\n要点 B');
  });

  it('turns English slide headings into separate local slides', () => {
    expect(normalizeSlidesMarkdown(
      'Slide 1: Opening\nPoint A\n\nSlide 2: Close\nPoint B',
    )).toBe('# Opening\nPoint A\n\n---\n\n# Close\nPoint B');
  });
});

describe('ChromeHtmlToImageRenderer', () => {
  it('calls the local browser executable directly without Python', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-html-shot-'));
    const htmlPath = path.join(tempDir, 'slide.html');
    const outputPath = path.join(tempDir, 'slide.png');
    fs.writeFileSync(htmlPath, '<!doctype html><h1>Local</h1>');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp0aNwAAAABJRU5ErkJggg==',
      'base64',
    );
    const runner = vi.fn(async (_executable: string, args: string[]) => {
      const screenshotArg = args.find((arg) => arg.startsWith('--screenshot='));
      fs.writeFileSync(screenshotArg!.slice('--screenshot='.length), png);
    });

    try {
      const renderer = new ChromeHtmlToImageRenderer('/local/chrome', runner);
      await renderer.render({
        htmlPath,
        outputPath,
        width: 1600,
        height: 900,
        signal: new AbortController().signal,
      });

      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner.mock.calls[0][0]).toBe('/local/chrome');
      expect(runner.mock.calls[0][1]).toContain('--window-size=1600,900');
      expect(runner.mock.calls[0][1].at(-1)).toBe(pathToFileURL(htmlPath).href);
      expect(runner.mock.calls[0][1].join(' ')).not.toMatch(/python/i);
      expect(runner.mock.calls[0][1].join(' ')).not.toContain('--user-data-dir=');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const localBrowser = findLocalBrowserExecutable();
  it.runIf(Boolean(localBrowser))('renders a real 1600x900 PNG with the installed local browser', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-html-shot-real-'));
    const htmlPath = path.join(tempDir, 'slide.html');
    const outputPath = path.join(tempDir, 'slide.png');
    fs.writeFileSync(
      htmlPath,
      '<!doctype html><style>html,body{margin:0;width:1600px;height:900px;background:#123456}</style>',
    );

    try {
      await new ChromeHtmlToImageRenderer(localBrowser).render({
        htmlPath,
        outputPath,
        width: 1600,
        height: 900,
        signal: new AbortController().signal,
      });
      const png = fs.readFileSync(outputPath);
      expect(png.readUInt32BE(16)).toBe(1600);
      expect(png.readUInt32BE(20)).toBe(900);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});
