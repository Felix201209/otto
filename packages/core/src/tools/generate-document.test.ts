/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import {
  type BrowserProcessHandle,
  ChromeHtmlToImageRenderer,
  createCachedDependencyPreflight,
  type DocumentCommandRunner,
  findLocalBrowserExecutable,
  GenerateDocumentTool,
  type HtmlToImageRenderer,
  normalizeSlidesMarkdown,
  runBrowserScreenshotProcess,
} from './generate-document.js';
import { createMockConfig } from '../utils/test-helpers.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import iconv from 'iconv-lite';

function hasBin(name: string): boolean {
  try { execSync('command -v ' + name, { stdio: 'ignore' }); return true; } catch { return false; }
}

class FakeBrowserProcess implements BrowserProcessHandle {
  readonly pid = 4242;
  exited = false;
  private closeListener?: (code: number | null, signal: NodeJS.Signals | null) => void;
  private errorListener?: (error: Error) => void;

  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.closeListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  kill(): boolean {
    return true;
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exited = true;
    this.closeListener?.(code, signal);
  }

  fail(error: Error): void {
    this.exited = true;
    this.errorListener?.(error);
  }
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

  it('caches successful dependency preflight but refreshes missing dependencies quickly', async () => {
    let now = 0;
    const backend = vi.fn(async () => null as string | null);
    const cached = createCachedDependencyPreflight(backend, () => now, {
      successTtlMs: 60_000,
      failureTtlMs: 1_000,
    });

    await cached(['typst']);
    await cached(['typst']);
    expect(backend).toHaveBeenCalledTimes(1);
    now = 60_001;
    await cached(['typst']);
    expect(backend).toHaveBeenCalledTimes(2);

    backend.mockResolvedValueOnce('typst missing');
    await cached(['pandoc']);
    await cached(['pandoc']);
    expect(backend).toHaveBeenCalledTimes(3);
    now += 1_001;
    await cached(['pandoc']);
    expect(backend).toHaveBeenCalledTimes(4);
  });

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
    const updates: string[] = [];
    const r = await tool.execute(
      { content: '# Hello\n\nWorld', format: 'article', output_format: 'markdown', title: 'T', output_path: out },
      new AbortController().signal,
      (output) => updates.push(output),
    );
    expect(r.llmContent).toContain('generate_document OK');
    expect(String(r.returnDisplay)).toContain('读取输入内容');
    expect(String(r.returnDisplay)).toContain('导出 Markdown 文件');
    expect(updates.at(-1)).toContain('导出 Markdown 文件');
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf8')).toContain('# T');
  });

  it('docx output uses bundled doc-writer and emits staged progress', async () => {
    const out = path.join(tmpDir, 'doc.docx');
    const updates: string[] = [];
    const commands: Array<{ file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const runner: DocumentCommandRunner = vi.fn(async (file, args, options) => {
      commands.push({ file, args, env: options.env });
      fs.writeFileSync(out, Buffer.from('PK fake docx'));
    });
    const docxTool = new GenerateDocumentTool(
      createMockConfig(),
      new ChromeHtmlToImageRenderer(null),
      runner,
      vi.fn(async () => null),
      vi.fn(() => ({
        executable: '/Applications/Otto.app/Contents/Resources/runtime/darwin-arm64/python/bin/python3',
        source: 'bundled',
        pythonSitePackages: '/Applications/Otto.app/Contents/Resources/runtime/darwin-arm64/python/site-packages',
      })),
    );

    const result = await docxTool.execute(
      {
        content: '## 正文\n\n- 第一条',
        format: 'report',
        output_format: 'docx',
        title: '公文测试',
        author: 'Otto',
        output_path: out,
      },
      new AbortController().signal,
      (output) => updates.push(output),
    );

    expect(result.llmContent).toContain('generate_document OK');
    expect(commands).toHaveLength(1);
    expect(commands[0].file).toContain('/runtime/darwin-arm64/python/bin/python3');
    expect(commands[0].args[0]).toContain('create_docx.py');
    expect(commands[0].args[2]).toBe(out);
    expect(commands[0].env?.PYTHONPATH).toContain('/runtime/darwin-arm64/python/site-packages');
    expect(commands[0].env?.PYTHONNOUSERSITE).toBe('1');
    expect(updates.join('\n')).toContain('预检 Python 公文依赖');
    expect(updates.join('\n')).toContain('导出 DOCX 文件');
  });

  // --- Doctor preflight: engine binaries checked BEFORE rendering ---
  const typstAvailable = hasBin('typst');
  const marpAvailable = hasBin('marp') || hasBin('marp-cli');

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

  it('honors visual layout directives, selected colors, and 1920x1080 rendering', async () => {
    const out = path.join(tmpDir, 'visual.pptx');
    const rendered: Array<{ html: string; width: number; height: number }> = [];
    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp0aNwAAAABJRU5ErkJggg==',
      'base64',
    );
    const htmlRenderer: HtmlToImageRenderer = {
      render: vi.fn(async ({ htmlPath, outputPath, width, height }) => {
        rendered.push({ html: fs.readFileSync(htmlPath, 'utf8'), width, height });
        fs.writeFileSync(outputPath, onePixelPng);
      }),
    };
    const htmlTool = new GenerateDocumentTool(createMockConfig(), htmlRenderer);
    const content = [
      '<!-- layout: cover -->\n# 增长不是偶然\n把正确动作变成复利',
      '<!-- layout: statement -->\n# 留存决定增长上限\n**42%** 的新增收入来自老用户',
      '<!-- layout: timeline -->\n# 三步完成转化\n1. 找到高意向人群\n2. 缩短决策路径\n3. 建立复购机制',
      '<!-- layout: split -->\n# 两条路径必须同时推进\n## 获客\n降低首次尝试门槛\n## 留存\n把价值交付提前',
      '<!-- layout: quote -->\n# 用户真正购买的是确定性\n> 让每一次使用都更接近结果',
    ].join('\n\n---\n\n');

    const result = await htmlTool.execute(
      {
        content,
        format: 'slides',
        output_format: 'pptx',
        output_path: out,
        title: '视觉叙事',
        template_options: [
          'PPT设计风格（商务）：克制、编辑感。',
          '主色 #1565C0 辅色 #42A5F5 强调色 #FF6B35 背景色 #F5F9FF 文字色 #1A365D',
        ].join('\n'),
      },
      new AbortController().signal,
    );

    expect(result.llmContent).toContain('generate_document OK');
    expect(rendered).toHaveLength(5);
    expect(rendered.every(({ width, height }) => width === 1920 && height === 1080)).toBe(true);
    expect(rendered.map(({ html }) => html.match(/<body[^>]*data-layout="([^"]+)"/)?.[1]))
      .toEqual(['cover', 'statement', 'timeline', 'split', 'quote']);
    expect(rendered[0].html).toContain('--primary: #1565C0');
    expect(rendered[0].html).toContain('--accent: #FF6B35');
    expect(rendered[0].html).toContain('data-style="business"');
    expect(rendered[3].html).toContain('class="panel"');
    expect(rendered.every(({ html }) => !html.includes('OTTO PRESENTATION'))).toBe(true);
    expect(rendered.every(({ html }) => !html.includes('class="shape-a"'))).toBe(true);
  });

  it('infers varied layouts and keeps local images as visual material', async () => {
    const out = path.join(tmpDir, 'inferred.pptx');
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
    const imagePath = path.join(tmpDir, 'evidence.png');
    fs.writeFileSync(imagePath, onePixelPng);

    await htmlTool.execute(
      {
        content: [
          '# 封面\n一句副标题',
          '# 关键数字\n**68%**',
          '# 执行路径\n1. 研究\n2. 原型\n3. 验证',
          `# 现场证据\n![真实截图](${imagePath})`,
        ].join('\n\n---\n\n'),
        format: 'slides',
        output_format: 'pptx',
        output_path: out,
        title: '自动版式',
      },
      new AbortController().signal,
    );

    expect(renderedHtml.map((html) => html.match(/<body[^>]*data-layout="([^"]+)"/)?.[1]))
      .toEqual(['cover', 'statement', 'timeline', 'visual']);
    expect(renderedHtml[3]).toContain('class="visual-image"');
    expect(renderedHtml[3]).toContain(pathToFileURL(imagePath).href);
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

  it('article->docx fails loud with the Python dependency repair when bundled runtime is unavailable', async () => {
    const out = path.join(tmpDir, 'a.docx');
    const docxTool = new GenerateDocumentTool(
      createMockConfig(),
      new ChromeHtmlToImageRenderer(null),
      vi.fn(),
      vi.fn(async (names) => names.includes('python-docx') ? 'python-docx 未安装：pip install python-docx' : null),
    );
    const r = await docxTool.execute(
      { content: '# Article\n\nText', format: 'article', output_format: 'docx', title: 'A', output_path: out },
      new AbortController().signal,
    );
    expect(r.llmContent).toContain('FAIL');
    expect(r.llmContent.toLowerCase()).toContain('python-docx');
    expect(r.llmContent).toContain('pip install python-docx');
  });

  it('passes Marp, Typst, and Pandoc paths as structured argv', async () => {
    const commandRunner = vi.fn(async (file: string, args: string[]) => {
      const outputPath = file === 'typst'
        ? args[2]
        : /python(?:3|\.exe)?$/i.test(file)
          ? args[2]
          : args[args.indexOf('-o') + 1];
      fs.writeFileSync(outputPath, `rendered by ${file}`);
    });
    const dependencyPreflight = vi.fn(async () => null);
    const unusedHtmlRenderer: HtmlToImageRenderer = { render: vi.fn() };
    const externalTool = new GenerateDocumentTool(
      createMockConfig(),
      unusedHtmlRenderer,
      commandRunner,
      dependencyPreflight,
    );

    const slidesOut = path.join(tmpDir, '季度 汇报.pdf');
    const reportOut = path.join(tmpDir, '年度 报告.pdf');
    const docxOut = path.join(tmpDir, '会议 纪要.docx');
    const signal = new AbortController().signal;

    const slides = await externalTool.execute(
      { content: '# 第一页', format: 'slides', output_format: 'pdf', output_path: slidesOut },
      signal,
    );
    const report = await externalTool.execute(
      { content: '# 报告', format: 'report', output_format: 'pdf', output_path: reportOut },
      signal,
    );
    const docx = await externalTool.execute(
      { content: '# 纪要', format: 'article', output_format: 'docx', output_path: docxOut },
      signal,
    );

    expect(slides.llmContent).toContain('generate_document OK');
    expect(report.llmContent).toContain('generate_document OK');
    expect(docx.llmContent).toContain('generate_document OK');
    expect(commandRunner).toHaveBeenNthCalledWith(
      1,
      'marp',
      [expect.stringMatching(/slides\.md$/), '-o', slidesOut, '--allow-local-files'],
      expect.objectContaining({ signal }),
    );
    expect(commandRunner).toHaveBeenNthCalledWith(
      2,
      'typst',
      ['compile', expect.stringMatching(/doc\.typ$/), reportOut],
      expect.objectContaining({ signal }),
    );
    expect(commandRunner).toHaveBeenNthCalledWith(
      3,
      expect.stringMatching(/python/),
      [
        expect.stringContaining('create_docx.py'),
        expect.stringMatching(/doc\.md$/),
        docxOut,
      ],
      expect.objectContaining({ signal }),
    );
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
    fs.writeFileSync(outputPath, png);
    let browserProfilePath: string | undefined;
    const runner = vi.fn(async (_executable: string, args: string[]) => {
      const screenshotArg = args.find((arg) => arg.startsWith('--screenshot='));
      const profileArg = args.find((arg) => arg.startsWith('--user-data-dir='));
      browserProfilePath = profileArg?.slice('--user-data-dir='.length);
      expect(browserProfilePath).toBeTruthy();
      expect(fs.existsSync(browserProfilePath!)).toBe(true);
      expect(fs.existsSync(outputPath)).toBe(false);
      fs.writeFileSync(screenshotArg!.slice('--screenshot='.length), png);
    });

    try {
      const renderer = new ChromeHtmlToImageRenderer('/local/chrome', runner);
      await renderer.render({
        htmlPath,
        outputPath,
        width: 1,
        height: 1,
        signal: new AbortController().signal,
      });

      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner.mock.calls[0][0]).toBe('/local/chrome');
      expect(runner.mock.calls[0][1]).toContain('--window-size=1,1');
      expect(runner.mock.calls[0][1].at(-1)).toBe(pathToFileURL(htmlPath).href);
      expect(runner.mock.calls[0][1].join(' ')).not.toMatch(/python/i);
      expect(runner.mock.calls[0][1].join(' ')).toContain('--user-data-dir=');
      expect(fs.existsSync(browserProfilePath!)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('removes a failed headless attempt before the legacy retry', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-html-retry-'));
    const htmlPath = path.join(tempDir, 'slide.html');
    const outputPath = path.join(tempDir, 'slide.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lp0aNwAAAABJRU5ErkJggg==',
      'base64',
    );
    fs.writeFileSync(htmlPath, '<!doctype html><h1>Retry</h1>');
    const runner = vi.fn(async (_executable: string, args: string[]) => {
      expect(fs.existsSync(outputPath)).toBe(false);
      fs.writeFileSync(outputPath, png);
      if (args.includes('--headless=new')) throw new Error('unsupported headless mode');
    });

    try {
      await new ChromeHtmlToImageRenderer('/local/chrome', runner).render({
        htmlPath,
        outputPath,
        width: 1,
        height: 1,
        signal: new AbortController().signal,
      });
      expect(runner).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps Abort as the first terminal outcome even if a PNG appears during shutdown', async () => {
    vi.useFakeTimers();
    const child = new FakeBrowserProcess();
    const terminations: boolean[] = [];
    let screenshotComplete = false;
    const controller = new AbortController();
    const promise = runBrowserScreenshotProcess(
      '/local/chrome',
      ['--screenshot=/tmp/otto-abort.png'],
      controller.signal,
      {
        timeoutMs: 100,
        pollIntervalMs: 5,
        killGraceMs: 20,
        spawnProcess: () => child,
        terminateProcess: (_process, force) => terminations.push(force),
        isScreenshotComplete: () => screenshotComplete,
      },
    );
    const assertion = expect(promise).rejects.toThrow('cancelled');

    try {
      controller.abort(new Error('cancelled'));
      screenshotComplete = true;
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(terminations).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps timeout as the first terminal outcome even if a PNG appears afterwards', async () => {
    vi.useFakeTimers();
    const child = new FakeBrowserProcess();
    const terminations: boolean[] = [];
    let screenshotComplete = false;
    const promise = runBrowserScreenshotProcess(
      '/local/chrome',
      ['--screenshot=/tmp/otto-timeout.png'],
      new AbortController().signal,
      {
        timeoutMs: 10,
        pollIntervalMs: 2,
        killGraceMs: 20,
        spawnProcess: () => child,
        terminateProcess: (_process, force) => terminations.push(force),
        isScreenshotComplete: () => screenshotComplete,
      },
    );
    const assertion = expect(promise).rejects.toThrow('浏览器截图超时');

    try {
      await vi.advanceTimersByTimeAsync(11);
      screenshotComplete = true;
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(terminations).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles after a bounded kill grace even when the browser never emits close', async () => {
    vi.useFakeTimers();
    const child = new FakeBrowserProcess();
    const terminations: boolean[] = [];
    const promise = runBrowserScreenshotProcess(
      '/local/chrome',
      ['--screenshot=/tmp/otto-no-close.png'],
      new AbortController().signal,
      {
        timeoutMs: 100,
        pollIntervalMs: 2,
        killGraceMs: 20,
        spawnProcess: () => child,
        terminateProcess: (_process, force) => terminations.push(force),
        isScreenshotComplete: () => true,
      },
    );
    const assertion = expect(promise).resolves.toBeUndefined();

    try {
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(terminations).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for asynchronous process-tree cleanup after the direct browser process closes', async () => {
    vi.useFakeTimers();
    const child = new FakeBrowserProcess();
    let finishTreeCleanup: (() => void) | undefined;
    const treeCleanup = new Promise<void>((resolve) => {
      finishTreeCleanup = resolve;
    });
    const promise = runBrowserScreenshotProcess(
      '/local/chrome',
      ['--screenshot=/tmp/otto-tree-cleanup.png'],
      new AbortController().signal,
      {
        timeoutMs: 100,
        pollIntervalMs: 2,
        killGraceMs: 50,
        spawnProcess: () => child,
        terminateProcess: () => treeCleanup,
        isScreenshotComplete: () => true,
      },
    );
    let settled = false;
    void promise.finally(() => {
      settled = true;
    });

    try {
      await vi.advanceTimersByTimeAsync(3);
      child.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      finishTreeCleanup?.();
      await vi.advanceTimersByTimeAsync(0);
      await expect(promise).resolves.toBeUndefined();
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
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

describe('document external command runner', () => {
  it('passes paths as argv and decodes GBK stderr on Windows', async () => {
    const module = await import('./generate-document.js') as Record<string, unknown>;
    expect(module.runDocumentCommand).toBeTypeOf('function');

    const inputPath = 'C:\\Users\\张三\\OneDrive - 示例公司\\输入 文档.md';
    const outputPath = 'C:\\Users\\张三\\桌面\\汇报 文件.pptx';
    const args = [inputPath, '-o', outputPath];
    const execFileImpl = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
    ) => {
      callback(
        Object.assign(new Error('Command failed'), { code: 1 }),
        Buffer.alloc(0),
        iconv.encode('系统找不到指定的路径', 'gbk'),
      );
    });

    const runDocumentCommand = module.runDocumentCommand as (
      file: string,
      argv: string[],
      options: Record<string, unknown>,
    ) => Promise<void>;
    await expect(runDocumentCommand('pandoc', args, {
      platform: 'win32',
      execFileImpl,
    })).rejects.toThrow('系统找不到指定的路径');

    expect(execFileImpl).toHaveBeenCalledWith(
      'pandoc',
      args,
      expect.objectContaining({ encoding: 'buffer', windowsHide: true }),
      expect.any(Function),
    );
  });

  it('runs the Windows npm Marp shim through ComSpec without joining user paths', async () => {
    const module = await import('./generate-document.js') as Record<string, unknown>;
    const runDocumentCommand = module.runDocumentCommand as (
      file: string,
      argv: string[],
      options: Record<string, unknown>,
    ) => Promise<void>;
    const args = [
      'C:\\Users\\张三\\AppData\\Local\\Temp\\otto doc\\slides.md',
      '-o',
      'C:\\Users\\张三\\桌面\\季度 汇报.pdf',
      '--allow-local-files',
    ];
    const execFileImpl = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, stdout: Buffer, stderr: Buffer) => void,
    ) => callback(null, Buffer.alloc(0), Buffer.alloc(0)));

    await runDocumentCommand('marp', args, {
      platform: 'win32',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
      execFileImpl,
    });

    expect(execFileImpl).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'marp', ...args],
      expect.objectContaining({ encoding: 'buffer', windowsHide: true }),
      expect.any(Function),
    );
  });
});
