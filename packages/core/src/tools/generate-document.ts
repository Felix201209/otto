/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
import pptxgen from 'pptxgenjs';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { DoctorService, CommandRunner } from '../services/doctor.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export interface HtmlToImageRenderRequest {
  htmlPath: string;
  outputPath: string;
  width: number;
  height: number;
  signal: AbortSignal;
}

export interface HtmlToImageRenderer {
  render(request: HtmlToImageRenderRequest): Promise<void>;
}

export type BrowserRunner = (
  executable: string,
  args: string[],
  signal: AbortSignal,
) => Promise<void>;

function findExecutableOnPath(names: string[], pathValue = process.env.PATH || ''): string | null {
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function findLocalBrowserExecutable(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  for (const configured of [env.OTTO_BROWSER_PATH, env.CHROME_PATH]) {
    if (configured && fs.existsSync(configured)) return configured;
  }

  if (platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    return candidates.find((candidate) => fs.existsSync(candidate))
      || findExecutableOnPath(['google-chrome', 'chromium', 'chromium-browser'], env.PATH);
  }

  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (value): value is string => Boolean(value),
    );
    const suffixes = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ];
    for (const root of roots) {
      for (const suffix of suffixes) {
        const candidate = path.join(root, ...suffix);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return findExecutableOnPath(['chrome.exe', 'msedge.exe', 'chromium.exe'], env.PATH);
  }

  return findExecutableOnPath(
    ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
    env.PATH,
  );
}

const defaultBrowserRunner: BrowserRunner = async (executable, args, signal) => {
  await execFileAsync(executable, args, {
    signal,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
};

/** 使用本机 Chromium 浏览器把本地 HTML 截成固定尺寸 PNG；不调用 Python。 */
export class ChromeHtmlToImageRenderer implements HtmlToImageRenderer {
  constructor(
    private readonly browserPath: string | null = findLocalBrowserExecutable(),
    private readonly runner: BrowserRunner = defaultBrowserRunner,
  ) {}

  async render(request: HtmlToImageRenderRequest): Promise<void> {
    if (!this.browserPath) {
      throw new Error(
        'PPT HTML 转图片需要本机 Chrome、Edge 或 Chromium；未找到可执行文件。',
      );
    }

    const commonArgs = [
      '--disable-background-networking',
      '--disable-gpu',
      '--disable-sync',
      '--hide-scrollbars',
      '--no-default-browser-check',
      '--no-first-run',
      '--run-all-compositor-stages-before-draw',
      '--allow-file-access-from-files',
      '--force-device-scale-factor=1',
      `--window-size=${request.width},${request.height}`,
      `--screenshot=${request.outputPath}`,
      '--virtual-time-budget=1000',
      pathToFileURL(request.htmlPath).href,
    ];

    try {
      await this.runner(this.browserPath, ['--headless=new', ...commonArgs], request.signal);
    } catch (error) {
      if (request.signal.aborted) throw error;
      await this.runner(this.browserPath, ['--headless', ...commonArgs], request.signal);
    }

    const png = fs.existsSync(request.outputPath)
      ? fs.readFileSync(request.outputPath)
      : Buffer.alloc(0);
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (png.length === 0 || !png.subarray(0, 8).equals(pngSignature)) {
      throw new Error(`HTML 转图片失败，浏览器未生成 PNG：${request.outputPath}`);
    }
  }
}

/**
 * 将常见的“第 N 页 / Slide N”大纲转换成本地幻灯片分页 Markdown。
 * 已经包含显式 `---` 分隔符的内容保持不变，避免改写用户手工排版。
 */
export function normalizeSlidesMarkdown(content: string): string {
  const normalized = content
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/^---[ \t]*\n+(?=#{1,6}\s)/, '');
  if (/^\s*---\s*$/m.test(normalized)) return normalized;

  const pageHeading = /^\s*(?:#{1,6}\s*)?((?:第\s*[一二三四五六七八九十百零〇两\d]+\s*页)|(?:(?:slide|page)\s*\d+))\s*(?:[:：\-—]\s*(.+))?\s*$/i;
  const lines = normalized.split('\n');
  const headingCount = lines.filter((line) => pageHeading.test(line)).length;
  if (headingCount < 2) return normalized;

  const output: string[] = [];
  let seenHeadings = 0;
  for (const line of lines) {
    const match = line.match(pageHeading);
    if (!match) {
      output.push(line);
      continue;
    }

    if (seenHeadings > 0) {
      while (output.at(-1) === '') output.pop();
      output.push('', '---', '');
    }
    output.push(`# ${(match[2] || match[1]).trim()}`);
    seenHeadings += 1;
  }
  return output.join('\n').trim();
}

/**
 * 执行前置体检：只读复用 DoctorService，但用一个「只放行目标二进制」的 runner，
 * 避免每次都 spawn 全部 10 个探测进程。缺任一目标依赖返回 fail-loud 错误（含平台
 * 安装命令）；全部就绪返回 null。marp 的 spec 会同时探测 marp/marp-cli。
 */
async function preflightBinaries(names: string[]): Promise<string | null> {
  const wanted = new Set(names);
  const binAliases = new Set<string>([...names, 'marp-cli']);
  const gatedRunner: CommandRunner = (command, timeoutMs) => {
    const touches = [...binAliases].some((n) =>
      new RegExp('(^|\\s|/)' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)').test(command),
    );
    if (!touches) return Promise.reject(new Error('skipped: ' + command));
    return new Promise<string>((resolve, reject) => {
      exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const out = (stdout || stderr || '').trim();
        if (err) { if (out) { resolve(out); return; } reject(err); return; }
        resolve(out);
      });
    });
  };
  const report = await new DoctorService(gatedRunner).check();
  const missing = report.checks.filter((c) => wanted.has(c.name) && !c.present);
  if (missing.length === 0) return null;
  return missing
    .map((c) => c.name + ' 未安装（' + c.category + '）。安装：' + (c.installHint || '见官方文档'))
    .join('；');
}

export interface GenerateDocumentToolParams {
  content: string;
  format: 'report'|'slides'|'letter'|'resume'|'article'|'table';
  output_format: 'pdf'|'docx'|'html'|'markdown'|'pptx';
  output_path?: string; title?: string; author?: string; template_options?: string;
}

export class GenerateDocumentTool extends BaseTool<GenerateDocumentToolParams, ToolResult> {
  static readonly Name: string = 'generate_document';

  constructor(
    private readonly config: Config,
    private readonly htmlRenderer: HtmlToImageRenderer = new ChromeHtmlToImageRenderer(),
  ) {
    const desc = `Generates polished documents from markdown content.

EXAMPLES:
  Report: {format:"report", output_format:"pdf", title:"Q3 Report", author:"Me", content:"# Summary\\n\\nContent here..."}
  Slides: {format:"slides", output_format:"pptx", title:"Presentation", content:"# Slide 1\\n\\n---\\n\\n# Slide 2"}
  Letter: {format:"letter", output_format:"pdf", title:"Regarding...", author:"Me", content:"Body text..."}
  Resume: {format:"resume", output_format:"pdf", title:"My Resume", content:"## Experience\\n\\n- Job 1..."}
  Simple: {format:"article", output_format:"markdown", content:"# Hello World"}

ENGINES: PPTX -> local HTML -> local browser PNG screenshots -> bundled PptxGenJS packaging. Slide PDF/HTML -> Marp. Other PDF -> Typst or Pandoc. docx/html -> Pandoc.

DEPENDENCIES: PPTX needs a local Chrome/Edge/Chromium browser and never runs Python. Markdown needs none. Slide PDF/HTML need marp-cli; other formats may need typst or pandoc. External engines run a doctor preflight and fail loud with an install command if missing (never faking output). macOS: brew install typst pandoc; npm i -g @marp-team/marp-cli. Windows: winget install typst pandoc; npm i -g @marp-team/marp-cli.`;
    super(GenerateDocumentTool.Name, 'GenerateDocument', desc, Icon.Pencil,
      {
        type: Type.OBJECT,
        properties: {
          content: { type: Type.STRING, description: 'Markdown content. Use # ## ### for headings, --- for slide breaks, - for lists, **bold**, *italic*' },
          format: { type: Type.STRING, enum: ['report','slides','letter','resume','article','table'], description: 'Document layout style' },
          output_format: { type: Type.STRING, enum: ['pdf','docx','html','markdown','pptx'], description: 'Output file format. Slides only: pdf, html, pptx.' },
          output_path: { type: Type.STRING, description: 'Output file path. Default: Desktop/generated_<ts>.<ext>' },
          title: { type: Type.STRING, description: 'Document title (appears in header/metadata)' },
          author: { type: Type.STRING, description: 'Author name (appears in metadata)' },
          template_options: { type: Type.STRING, description: 'Extra flags for the rendering engine' },
        },
        required: ['content','format','output_format'],
      },
    );
  }

  validateToolParams(p: GenerateDocumentToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, GenerateDocumentTool.Name);
    if (e) return e;
    if (!p.content?.trim()) return 'generate_document: content is required';
    if (p.format==='slides' && !['pdf','html','pptx'].includes(p.output_format))
      return 'generate_document/slides: output_format must be pdf, html, or pptx. Got: '+p.output_format;
    return null;
  }

  toolLocations(p: GenerateDocumentToolParams): ToolLocation[] {
    return p.output_path ? [{ path: p.output_path }] : [];
  }
  getDescription(p: GenerateDocumentToolParams): string {
    return 'generate '+p.format+' as '+p.output_format;
  }
  async shouldConfirmExecute(p: GenerateDocumentToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    if (this.validateToolParams(p)) return false;
    return { type:'exec', title:'Confirm: '+this.getDescription(p), command:'generate_document', rootCommand:'generate_document', onConfirm: async ()=>{}};
  }

  async execute(p: GenerateDocumentToolParams, signal: AbortSignal): Promise<ToolResult> {
    const logLabel = 'generate_document.'+(p.output_format || p.format);
    console.time(logLabel);
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    const { content, format, output_format, title, author } = p;
    const titleStr = title || 'Untitled';
    const authorStr = author || '';
    const outPath = p.output_path || path.join(os.homedir(), 'Desktop', 'generated_'+Date.now()+'.'+output_format);
    const tmpDir = path.join(os.tmpdir(), 'otto-doc-'+Date.now());
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      if (format === 'slides') {
        await this.genSlides(content, output_format, outPath, tmpDir, titleStr, signal);
      } else if (output_format === 'markdown') {
        fs.writeFileSync(outPath, '# '+titleStr+'\n'+(authorStr?'**'+authorStr+'**\n':'')+'\n'+content);
      } else if (output_format === 'pdf' && ['report','article','letter','resume'].includes(format)) {
        await this.genTypst(content, format, outPath, tmpDir, titleStr, authorStr);
      } else {
        await this.genPandoc(content, outPath, tmpDir, titleStr, authorStr, output_format, format);
      }

      const sz = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
      const label = path.basename(outPath)+' ('+format+', '+sz+' bytes)';
      return { llmContent: 'generate_document OK: '+label, returnDisplay: 'generate_document OK: '+label };
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      if (m.includes('not found') || m.includes('command not found')) {
        return { llmContent: 'generate_document FAIL: tool not installed. macOS: brew install typst pandoc; npm i -g @marp-team/marp-cli. '+m, returnDisplay: 'generate_document FAIL: tool not installed' };
      }
      return { llmContent: 'generate_document FAIL: '+m, returnDisplay: 'generate_document FAIL: '+m };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不应覆盖真实的生成结果或错误。
      }
      console.timeEnd(logLabel);
    }
  }

  private async genSlides(
    content: string,
    fmt: string,
    outPath: string,
    tmpDir: string,
    title: string,
    signal: AbortSignal,
  ): Promise<void> {
    const slides = normalizeSlidesMarkdown(content);
    if (fmt === 'pptx') {
      await this.genPptx(slides, outPath, title, tmpDir, signal);
      return;
    }

    // PDF/HTML slides render via Marp. Fail loud if missing.
    const missing = await preflightBinaries(['marp']);
    if (missing) throw new Error('generate_document/slides needs marp: ' + missing);
    const mdFile = path.join(tmpDir, 'slides.md');
    fs.writeFileSync(mdFile, '---\nmarp: true\ntheme: default\npaginate: true\ntitle: '+title+'\n---\n\n'+slides);
    await execAsync('marp "'+mdFile+'" -o "'+outPath+'" --allow-local-files', { maxBuffer:50*1024*1024 });
  }

  private async genPptx(
    content: string,
    outPath: string,
    documentTitle: string,
    tmpDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    // pptxgenjs 4.0.1 的 NodeNext 类型导出会被 TS 误判为模块命名空间；
    // 实际 ESM default export 是可构造类（官方 Node/Electron 用法亦如此）。
    // @ts-expect-error upstream NodeNext default-export typing mismatch
    const presentation = new pptxgen();
    presentation.layout = 'LAYOUT_WIDE';
    presentation.author = 'Otto';
    presentation.company = 'Otto';
    presentation.subject = documentTitle;
    presentation.title = documentTitle;

    const parsedSlides = content
      .split(/^\s*---\s*$/m)
      .map((section) => this.parseSlideSection(section, documentTitle))
      .filter((section) => section.title || section.body.length > 0);
    if (parsedSlides.length === 0) {
      parsedSlides.push({ title: documentTitle, body: [], notes: [] });
    }

    for (let index = 0; index < parsedSlides.length; index += 1) {
      if (signal.aborted) throw new Error('PPT 本地生成已取消');
      const section = parsedSlides[index];
      const htmlPath = path.join(tmpDir, `slide-${index + 1}.html`);
      const imagePath = path.join(tmpDir, `slide-${index + 1}.png`);
      fs.writeFileSync(
        htmlPath,
        this.buildSlideHtml(section, index, parsedSlides.length),
        'utf8',
      );
      await this.htmlRenderer.render({
        htmlPath,
        outputPath: imagePath,
        width: 1600,
        height: 900,
        signal,
      });

      const slide = presentation.addSlide();
      slide.addImage({
        path: imagePath,
        altText: section.title || documentTitle,
        x: 0,
        y: 0,
        w: 13.333,
        h: 7.5,
      });
      if (section.notes.length > 0) slide.addNotes(section.notes.join('\n'));
    }

    await presentation.writeFile({ fileName: outPath, compression: true });
  }

  private buildSlideHtml(
    section: { title: string; body: string[]; notes: string[] },
    index: number,
    total: number,
  ): string {
    const isCover = index === 0;
    const title = this.escapeHtml(section.title);
    const body = this.renderSlideBodyHtml(section.body);
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1600,height=900,initial-scale=1">
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html, body { width: 1600px; height: 900px; margin: 0; overflow: hidden; }
    body {
      background: #f8fafc;
      color: #0f172a;
      font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body.cover { background: #0f172a; color: #f8fafc; }
    .accent { position: absolute; inset: 0 auto 0 0; width: 18px; background: #2563eb; }
    body:not(.cover) .accent { inset: 0 0 auto 0; width: 100%; height: 12px; }
    .deck { position: relative; width: 100%; height: 100%; padding: 82px 96px 64px; }
    body.cover .deck { padding: 132px 110px 72px; }
    h1 {
      max-width: 1320px;
      margin: 0;
      font-size: 54px;
      line-height: 1.15;
      letter-spacing: -0.02em;
      font-weight: 750;
      text-wrap: balance;
    }
    body.cover h1 { max-width: 1220px; font-size: 68px; }
    .content {
      max-width: 1320px;
      margin-top: 54px;
      font-size: 30px;
      line-height: 1.45;
      color: #334155;
    }
    body.cover .content { max-width: 1180px; margin-top: 72px; color: #cbd5e1; }
    .content p { margin: 0 0 20px; }
    .content h2 { margin: 28px 0 14px; font-size: 34px; line-height: 1.25; color: #1d4ed8; }
    body.cover .content h2 { color: #93c5fd; }
    .content ul, .content ol { margin: 0 0 22px; padding-left: 1.25em; }
    .content li { margin: 0 0 13px; padding-left: 0.2em; }
    .content blockquote {
      margin: 24px 0;
      padding: 14px 20px;
      border-left: 5px solid #2563eb;
      color: #475569;
      background: #eff6ff;
    }
    body.cover .content blockquote { color: #dbeafe; background: #172554; }
    code { padding: 0.08em 0.28em; border-radius: 5px; background: #e2e8f0; font-family: ui-monospace, monospace; font-size: 0.86em; }
    body.cover code { background: #1e293b; }
    footer {
      position: absolute;
      right: 72px;
      bottom: 38px;
      color: #94a3b8;
      font-size: 16px;
      letter-spacing: 0.04em;
    }
    body.cover footer { color: #64748b; }
  </style>
</head>
<body class="${isCover ? 'cover' : 'content-slide'}" data-slide-index="${index + 1}">
  <div class="accent" aria-hidden="true"></div>
  <main class="deck">
    <h1>${title}</h1>
    <section class="content">${body}</section>
  </main>
  <footer>${index + 1} / ${total}</footer>
</body>
</html>`;
  }

  private renderSlideBodyHtml(lines: string[]): string {
    const output: string[] = [];
    let listType: 'ul' | 'ol' | null = null;
    const closeList = () => {
      if (listType) output.push(`</${listType}>`);
      listType = null;
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        closeList();
        continue;
      }

      const bullet = line.match(/^[-*+]\s+(.+)$/);
      const numbered = line.match(/^\d+[.)]\s+(.+)$/);
      if (bullet || numbered) {
        const nextListType: 'ul' | 'ol' = bullet ? 'ul' : 'ol';
        if (listType !== nextListType) {
          closeList();
          listType = nextListType;
          output.push(`<${listType}>`);
        }
        output.push(`<li>${this.renderInlineMarkdown((bullet || numbered)![1])}</li>`);
        continue;
      }

      closeList();
      const heading = line.match(/^#{2,6}\s+(.+)$/);
      if (heading) {
        output.push(`<h2>${this.renderInlineMarkdown(heading[1])}</h2>`);
        continue;
      }
      const quote = line.match(/^>\s*(.+)$/);
      if (quote) {
        output.push(`<blockquote>${this.renderInlineMarkdown(quote[1])}</blockquote>`);
        continue;
      }
      output.push(`<p>${this.renderInlineMarkdown(line)}</p>`);
    }
    closeList();
    return output.join('');
  }

  private renderInlineMarkdown(value: string): string {
    return this.escapeHtml(value)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private parseSlideSection(
    section: string,
    fallbackTitle: string,
  ): { title: string; body: string[]; notes: string[] } {
    const withoutComments = section.replace(/<!--[\s\S]*?-->/g, '').trim();
    const lines = withoutComments.split('\n');
    const titleIndex = lines.findIndex((line) => /^#{1,6}\s+/.test(line.trim()));
    const title = titleIndex >= 0
      ? this.cleanInlineMarkdown(lines[titleIndex].replace(/^#{1,6}\s+/, ''))
      : fallbackTitle;
    const notes: string[] = [];
    const body = lines.filter((line, index) => {
      if (index === titleIndex) return false;
      const note = line.match(/^\s*(?:讲者备注|speaker notes?)\s*[:：]\s*(.*)$/i);
      if (note) {
        if (note[1].trim()) notes.push(this.cleanInlineMarkdown(note[1]));
        return false;
      }
      return true;
    });
    return { title, body, notes };
  }

  private cleanInlineMarkdown(value: string): string {
    return value
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
  }
  private async genTypst(content: string, format: string, outPath: string, tmpDir: string, title: string, author: string): Promise<void> {
    // Doctor preflight: typst-rendered PDFs (report/article/letter/resume) need typst.
    const missing = await preflightBinaries(['typst']);
    if (missing) throw new Error('generate_document (' + format + ' -> pdf) needs typst: ' + missing);
    const typFile = path.join(tmpDir, 'doc.typ');
    fs.writeFileSync(typFile, this.md2typst(content, format, title, author));
    await execAsync('typst compile "'+typFile+'" "'+outPath+'"', { maxBuffer:50*1024*1024 });
  }
  private async genPandoc(content: string, outPath: string, tmpDir: string, title: string, author: string, fmt: string, format: string): Promise<void> {
    // Doctor preflight: docx/html and table PDFs render via pandoc. Fail loud if missing.
    const missing = await preflightBinaries(['pandoc']);
    if (missing) throw new Error('generate_document (' + format + ' -> ' + fmt + ') needs pandoc: ' + missing);
    const mdFile = path.join(tmpDir, 'doc.md');
    fs.writeFileSync(mdFile, '# '+title+'\n'+(author?'**'+author+'**\n':'')+'\n'+content);
    const extra = format==='report' ? ' --toc --number-sections' : '';
    await execAsync('pandoc "'+mdFile+'" -o "'+outPath+'" -f markdown -t '+fmt+' --standalone'+extra, { maxBuffer:50*1024*1024 });
  }

  private md2typst(md: string, format: string, title: string, author: string): string {
    const now = new Date().toLocaleDateString();
    let preamble = '#set document(title: "'+this.te(title)+'", author: "'+this.te(author)+'", date: "'+now+'")\n\n';
    if (format==='report'||format==='article') {
      preamble += '#set page(paper: "a4", margin: (x: 2.5cm, y: 2.5cm), numbering: "1")\n';
      preamble += '#set text(font: "New Computer Modern", size: 11pt)\n#set par(justify: true, leading: 0.8em)\n';
      preamble += '#show heading: it => { if it.level == 1 [= #it.body] else if it.level == 2 [== #it.body] else [=== #it.body] }\n#pagebreak()\n';
    } else if (format==='letter') {
      preamble += '#set page(paper: "a4", margin: 2.5cm)\n#set text(font: "New Computer Modern", size: 11pt)\n#set par(justify: true)\n';
    } else if (format==='resume') {
      preamble += '#set page(paper: "a4", margin: 1.5cm)\n#set text(font: "New Computer Modern", size: 10pt)\n';
    } else {
      preamble += '#set page(paper: "a4", margin: 2.5cm)\n#set text(size: 11pt)\n#set par(justify: true)\n';
    }

    const cb: string[] = [];
    let s = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, body) => {
      cb.push('#raw(block: true'+(lang?', lang: "'+this.te(lang)+'"':'')+', "'+this.te(body.trim())+'")');
      return '\uE000CB'+ (cb.length-1) +'\uE001';
    });
    const ic: string[] = [];
    s = s.replace(/`([^`]+)`/g, (_, body) => { ic.push('#raw("'+this.te(body)+'")'); return '\uE000IC'+ (ic.length-1) +'\uE001'; });
    s = s.replace(/^### (.+)$/gm, '=== $1');
    s = s.replace(/^## (.+)$/gm, '== $1');
    s = s.replace(/^# (.+)$/gm, '= $1');
    s = s.replace(/\*\*(.+?)\*\*/g, '*$1*');
    s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_');
    s = s.replace(/^> (.+)$/gm, '#quote[$1]');
    s = s.replace(/^- (.+)$/gm, '- $1');
    s = s.replace(/^(\d+)\. (.+)$/gm, '+ $2');
    s = s.replace(/\uE000CB(\d+)\uE001/g, (_, i) => cb[+i]);
    s = s.replace(/\uE000IC(\d+)\uE001/g, (_, i) => ic[+i]);
    return preamble + '\n' + s;
  }
  private te(s: string): string { return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,' '); }
}
