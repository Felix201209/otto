/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { exec, execFile, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import pptxgen from 'pptxgenjs';
import iconv from 'iconv-lite';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { DoctorService, CommandRunner } from '../services/doctor.js';
import {
  buildBundledPythonEnvironment,
  resolveDocumentRuntime,
  type DocumentRuntimeKind,
  type DocumentRuntimeResolution,
  type ResolveDocumentRuntimeOptions,
} from '../services/bundledRuntime.js';

type ExecFileCallback = (
  error: NodeJS.ErrnoException | null,
  stdout: Buffer | string,
  stderr: Buffer | string,
) => void;

export type ExecFileImplementation = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
  callback: ExecFileCallback,
) => unknown;

export interface RunDocumentCommandOptions {
  platform?: NodeJS.Platform;
  comspec?: string;
  windowsEncoding?: string;
  execFileImpl?: ExecFileImplementation;
  signal?: AbortSignal;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

let cachedWindowsConsoleEncoding: string | undefined;

function isUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function detectWindowsConsoleEncoding(): string {
  if (cachedWindowsConsoleEncoding) return cachedWindowsConsoleEncoding;
  try {
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    const raw = execFileSync(comspec, ['/d', '/s', '/c', 'chcp'], {
      encoding: 'buffer',
      windowsHide: true,
      timeout: 3_000,
    });
    const match = raw.toString('latin1').match(/\b(\d{3,5})\b/);
    const codePage = match?.[1];
    cachedWindowsConsoleEncoding = codePage === '65001'
      ? 'utf8'
      : codePage === '936'
        ? 'gb18030'
        : codePage === '950'
          ? 'big5'
          : codePage
            ? `cp${codePage}`
            : 'gb18030';
  } catch {
    // Otto 国内 Windows 用户以 CP936 为主；无法探测时优先避免中文错误乱码。
    cachedWindowsConsoleEncoding = 'gb18030';
  }
  return cachedWindowsConsoleEncoding;
}

function decodeCommandOutput(
  value: Buffer | string,
  platform: NodeJS.Platform,
  windowsEncoding?: string,
): string {
  if (typeof value === 'string') return value;
  if (value.length === 0) return '';
  if (isUtf8(value)) return value.toString('utf8');
  if (platform !== 'win32') return value.toString('utf8');

  const encoding = windowsEncoding || detectWindowsConsoleEncoding();
  return iconv.encodingExists(encoding)
    ? iconv.decode(value, encoding)
    : value.toString('utf8');
}

const defaultExecFileImpl: ExecFileImplementation = (
  file,
  args,
  options,
  callback,
) => execFile(file, [...args], options, callback as never);

/**
 * 以 argv 方式运行文档渲染器，避免把用户路径拼进 shell 命令字符串。
 * stdout/stderr 以 Buffer 接收；Windows 非 UTF-8 控制台输出按当前代码页解码。
 */
export function runDocumentCommand(
  file: string,
  args: string[],
  options: RunDocumentCommandOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const execFileImpl = options.execFileImpl ?? defaultExecFileImpl;
  const usesWindowsNpmShim = platform === 'win32'
    && /^(?:marp|marp-cli)(?:\.cmd)?$/i.test(path.basename(file));
  const executable = usesWindowsNpmShim
    ? (options.comspec || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe')
    : file;
  const argv = usesWindowsNpmShim
    ? ['/d', '/s', '/c', file, ...args]
    : args;
  return new Promise<void>((resolve, reject) => {
    execFileImpl(
      executable,
      argv,
      {
        encoding: 'buffer',
        windowsHide: true,
        timeout: options.timeout ?? 30_000,
        maxBuffer: options.maxBuffer ?? 50 * 1024 * 1024,
        signal: options.signal,
        env: options.env,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const detail = decodeCommandOutput(
          (stderr && stderr.length > 0) ? stderr : stdout,
          platform,
          options.windowsEncoding,
        ).trim();
        const wrapped = new Error(detail || error.message);
        Object.assign(wrapped, { code: error.code, cause: error });
        reject(wrapped);
      },
    );
  });
}

export type DocumentCommandRunner = typeof runDocumentCommand;
export type DependencyPreflight = (names: string[]) => Promise<string | null>;
export type DocumentRuntimeResolver = (
  kind: DocumentRuntimeKind,
  options?: ResolveDocumentRuntimeOptions,
) => DocumentRuntimeResolution;
type ProgressReporter = (output: string) => void;

export function createCachedDependencyPreflight(
  backend: DependencyPreflight,
  now: () => number = Date.now,
  options: { successTtlMs?: number; failureTtlMs?: number } = {},
): DependencyPreflight {
  const successTtlMs = options.successTtlMs ?? 5 * 60_000;
  const failureTtlMs = options.failureTtlMs ?? 10_000;
  const cache = new Map<string, { result: string | null; expiresAt: number }>();
  const inFlight = new Map<string, Promise<string | null>>();
  return async (names: string[]): Promise<string | null> => {
    const normalized = [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort();
    const key = normalized.join('\0');
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.result;
    const active = inFlight.get(key);
    if (active) return active;
    const request = backend(normalized).then((result) => {
      cache.set(key, {
        result,
        expiresAt: now() + (result === null ? successTtlMs : failureTtlMs),
      });
      return result;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  };
}

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

type SlideLayout =
  | 'cover'
  | 'section'
  | 'statement'
  | 'list'
  | 'editorial'
  | 'split'
  | 'timeline'
  | 'quote'
  | 'visual';

interface ParsedSlideSection {
  title: string;
  body: string[];
  notes: string[];
  requestedLayout?: SlideLayout;
}

interface SlideTheme {
  style: 'editorial' | 'business' | 'flat' | 'travel' | 'advertising' | 'anime';
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  surface: string;
  muted: string;
  coverBackground: string;
  coverText: string;
}

interface NativeSlideTextBlock {
  lines: string[];
  fontSize: number;
  color?: string;
  bold?: boolean;
  isBullet?: boolean;
  indent?: number;
}

interface NativeSlideTable {
  headers: string[];
  rows: string[][];
}

interface NativePptxTextRun {
  text: string;
  options: {
    fontSize: number;
    color: string;
    fontFace: string;
    bold?: boolean;
    bullet?: { code: string; color: string };
    breakType?: 'none';
    fill?: { color: string };
  };
}

type NativePptxTableRow = NativePptxTextRun[];

interface NativePptxTextOptions {
  x: number;
  y: number;
  w: number;
  h: number;
  valign?: 'top' | 'middle' | 'bottom';
  lineSpacingMultiple?: number;
}

interface NativePptxSlide {
  background: { color: string };
  addImage(options: { path: string; altText: string; x: number; y: number; w: number; h: number }): void;
  addNotes(notes: string): void;
  addShape(shapeName: string, options: {
    x: number;
    y: number;
    w: number;
    h: number;
    fill: { color: string };
    line: { color: string; width: number };
  }): void;
  addTable(rows: NativePptxTableRow[], options: {
    x: number;
    y: number;
    w: number;
    border: { type: 'solid'; pt: number; color: string };
    rowH: number;
  }): void;
  addText(text: string | NativePptxTextRun[], options: NativePptxTextOptions & {
    fontSize?: number;
    bold?: boolean;
    align?: 'left' | 'center' | 'right';
    color?: string;
    fontFace?: string;
  }): void;
}

interface NativePptxPresentation {
  layout: string;
  author: string;
  company: string;
  subject: string;
  title: string;
  readonly ShapeType?: { rect?: string };
  addSlide(): NativePptxSlide;
  writeFile(options: { fileName: string; compression: boolean }): Promise<unknown>;
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

const pngEndMarker = Buffer.from([
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);
const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47,
  0x0d, 0x0a, 0x1a, 0x0a,
]);

function isCompletePng(filePath: string | undefined): boolean {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const png = fs.readFileSync(filePath);
    return png.length >= 24 + pngEndMarker.length
      && png.subarray(0, pngSignature.length).equals(pngSignature)
      && png.subarray(-pngEndMarker.length).equals(pngEndMarker);
  } catch {
    return false;
  }
}

export interface BrowserProcessHandle {
  readonly pid?: number;
  readonly exited: boolean;
  onClose(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface BrowserScreenshotProcessOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  killGraceMs?: number;
  spawnProcess?: (executable: string, args: string[]) => BrowserProcessHandle;
  terminateProcess?: (
    processHandle: BrowserProcessHandle,
    force: boolean,
  ) => void | Promise<void>;
  isScreenshotComplete?: (filePath: string | undefined) => boolean;
}

function spawnBrowserProcess(executable: string, args: string[]): BrowserProcessHandle {
  const child = spawn(executable, args, {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });

  return {
    pid: child.pid,
    get exited() {
      return child.exitCode !== null || child.signalCode !== null;
    },
    onClose(listener) {
      child.once('close', (code, signal) => listener(code, signal));
    },
    onError(listener) {
      child.once('error', listener);
    },
    kill(signal) {
      return child.kill(signal);
    },
  };
}

function terminateBrowserProcessTree(
  processHandle: BrowserProcessHandle,
  force: boolean,
): void | Promise<void> {
  const signal: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';

  if (process.platform === 'win32') {
    if (processHandle.pid) {
      return new Promise<void>((resolve) => {
        // Chromium launches helper processes. Always kill the complete tree on
        // Windows before allowing a fallback attempt to reuse the output path.
        // `/F` is intentional even for the first request: killing only the
        // direct parent can orphan helpers after the parent's close event.
        execFile(
          'taskkill',
          ['/PID', String(processHandle.pid), '/T', '/F'],
          { windowsHide: true, timeout: 1_000 },
          () => resolve(),
        );
      });
    }
    if (!processHandle.exited) processHandle.kill(signal);
    return;
  }

  if (processHandle.pid) {
    try {
      process.kill(-processHandle.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the process group already vanished.
    }
  }
  processHandle.kill(signal);
}

function browserAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('浏览器截图已取消。');
}

type BrowserProcessOutcome =
  | { kind: 'success' }
  | { kind: 'failure'; error: Error };

export function runBrowserScreenshotProcess(
  executable: string,
  args: string[],
  signal: AbortSignal,
  options: BrowserScreenshotProcessOptions = {},
): Promise<void> {
  if (signal.aborted) return Promise.reject(browserAbortError(signal));

  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const killGraceMs = options.killGraceMs ?? 1_000;
  const spawnProcess = options.spawnProcess ?? spawnBrowserProcess;
  const terminateProcess = options.terminateProcess ?? terminateBrowserProcessTree;
  const isScreenshotComplete = options.isScreenshotComplete ?? isCompletePng;
  const screenshotPath = args
    .find((arg) => arg.startsWith('--screenshot='))
    ?.slice('--screenshot='.length);

  return new Promise<void>((resolve, reject) => {
    let processHandle: BrowserProcessHandle;
    try {
      processHandle = spawnProcess(executable, args);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let outcome: BrowserProcessOutcome | undefined;
    let settled = false;
    let terminationStarted = false;
    let forceRequested = false;
    let processClosed = false;
    let requiredTerminationAttempt = 0;
    let completedTerminationAttempt = 0;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let hardSettleTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearInterval(pngPollTimer);
      clearTimeout(commandTimeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
      signal.removeEventListener('abort', abort);
    };

    const settle = () => {
      if (settled || !outcome) return;
      settled = true;
      cleanup();
      if (outcome.kind === 'success') {
        resolve();
      } else {
        reject(outcome.error);
      }
    };

    const completeTerminationAttempt = (attempt: number) => {
      completedTerminationAttempt = Math.max(
        completedTerminationAttempt,
        attempt,
      );
      if (
        processClosed
        && completedTerminationAttempt >= requiredTerminationAttempt
      ) {
        settle();
      }
    };

    const runTerminationAttempt = (force: boolean) => {
      const attempt = force ? 2 : 1;
      requiredTerminationAttempt = Math.max(
        requiredTerminationAttempt,
        attempt,
      );
      try {
        void Promise.resolve(terminateProcess(processHandle, force)).then(
          () => completeTerminationAttempt(attempt),
          () => completeTerminationAttempt(attempt),
        );
      } catch {
        completeTerminationAttempt(attempt);
      }
    };

    const requestTermination = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      forceKillTimer = setTimeout(() => {
        if (forceRequested) return;
        forceRequested = true;
        runTerminationAttempt(true);
      }, Math.max(1, Math.floor(killGraceMs / 2)));
      hardSettleTimer = setTimeout(settle, killGraceMs);
      runTerminationAttempt(false);
    };

    const finishFirst = (nextOutcome: BrowserProcessOutcome) => {
      if (outcome || settled) return;
      outcome = nextOutcome;
      clearInterval(pngPollTimer);
      clearTimeout(commandTimeout);
      signal.removeEventListener('abort', abort);
      requestTermination();
    };

    function abort(): void {
      finishFirst({ kind: 'failure', error: browserAbortError(signal) });
    }

    processHandle.onClose((code, closeSignal) => {
      processClosed = true;
      if (!outcome) {
        outcome = isScreenshotComplete(screenshotPath)
          ? { kind: 'success' }
          : {
              kind: 'failure',
              error: new Error(
                `浏览器截图进程退出（code=${String(code)}, signal=${String(closeSignal)}），但未生成完整 PNG。`,
              ),
            };
      }
      if (
        !terminationStarted
        || completedTerminationAttempt >= requiredTerminationAttempt
      ) {
        settle();
      }
    });
    processHandle.onError((error) => {
      if (outcome) return;
      processClosed = true;
      outcome = { kind: 'failure', error };
      settle();
    });

    const pngPollTimer = setInterval(() => {
      if (!isScreenshotComplete(screenshotPath)) return;
      finishFirst({ kind: 'success' });
    }, pollIntervalMs);
    const commandTimeout = setTimeout(() => {
      const timeoutError = Object.assign(
        new Error(`浏览器截图超时（${timeoutMs} 毫秒）。`),
        { code: 'BROWSER_SCREENSHOT_TIMEOUT' },
      );
      finishFirst({
        kind: 'failure',
        error: timeoutError,
      });
    }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

const defaultBrowserRunner: BrowserRunner = (executable, args, signal) => (
  runBrowserScreenshotProcess(executable, args, signal)
);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function findBundledDocWriterScript(): string | null {
  const candidates = [
    path.resolve(moduleDir, '../../skills-seed/doc-writer/scripts/create_docx.py'),
    path.resolve(moduleDir, '../../../skills-seed/doc-writer/scripts/create_docx.py'),
    path.resolve(moduleDir, '../../../../skills-seed/doc-writer/scripts/create_docx.py'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

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

    // A dedicated profile prevents an already-running desktop Chrome instance
    // from absorbing the headless command and leaving the renderer hanging.
    const browserProfilePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-chrome-profile-'),
    );
    try {
      const commonArgs = [
        `--user-data-dir=${browserProfilePath}`,
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
      const runAttempt = async (headlessArg: '--headless=new' | '--headless') => {
        // Each attempt starts without a stale file, including the legacy retry.
        fs.rmSync(request.outputPath, { force: true });
        await this.runner(this.browserPath!, [headlessArg, ...commonArgs], request.signal);
      };

      try {
        await runAttempt('--headless=new');
      } catch (error) {
        const errorCode = error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
        if (request.signal.aborted || errorCode === 'BROWSER_SCREENSHOT_TIMEOUT') throw error;
        await runAttempt('--headless');
      }

      const png = fs.existsSync(request.outputPath)
        ? fs.readFileSync(request.outputPath)
        : Buffer.alloc(0);
      const hasExpectedDimensions = png.length >= 24
        && png.readUInt32BE(16) === request.width
        && png.readUInt32BE(20) === request.height;
      if (!isCompletePng(request.outputPath) || !hasExpectedDimensions) {
        throw new Error(`HTML 转图片失败，浏览器未生成 PNG：${request.outputPath}`);
      }
    } finally {
      try {
        await fs.promises.rm(browserProfilePath, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      } catch {
        // The profile is disposable and contains no user profile data. A
        // cleanup failure must not hide the renderer's primary result.
      }
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
  const remaining = new Set(names);
  const pythonModules = [
    ['python-docx', 'docx'],
    ['jinja2', 'jinja2'],
    ['markdown', 'markdown'],
  ] as const;
  const python = resolveDocumentRuntime('python');
  if (python.source === 'bundled' && (
    remaining.has('python3')
    || pythonModules.some(([packageName]) => remaining.has(packageName))
  )) {
    const imports = pythonModules
      .filter(([packageName]) => remaining.has(packageName))
      .map(([, importName]) => importName);
    try {
      if (imports.length > 0) {
        await runDocumentCommand(
          python.executable,
          ['-c', imports.map((name) => `import ${name}`).join('; ')],
          { env: buildBundledPythonEnvironment(python), timeout: 10_000 },
        );
      }
      remaining.delete('python3');
      for (const [packageName] of pythonModules) remaining.delete(packageName);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return `内置 Python 运行时缺少必需模块（${imports.join(', ')}）：${detail}`;
    }
  }
  if (remaining.size === 0) return null;
  const wanted = remaining;
  const binAliases = new Set<string>([...remaining, 'marp-cli']);
  const gatedRunner: CommandRunner = (command, timeoutMs) => {
    const locator = command.match(/^(?:where|which)\s+([^\s]+)$/i);
    if (locator && binAliases.has(locator[1])) {
      const bin = locator[1];
      const candidates = process.platform === 'win32'
        ? [bin, `${bin}.exe`, `${bin}.cmd`, `${bin}.bat`]
        : [bin];
      const executable = findExecutableOnPath(candidates);
      return executable
        ? Promise.resolve(executable)
        : Promise.reject(new Error(`${bin} not found on PATH`));
    }
    const touches = [...binAliases].some((n) =>
      new RegExp('(^|\\s|/)' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)').test(command),
    );
    if (!touches) return Promise.reject(new Error('skipped: ' + command));
    return new Promise<string>((resolve, reject) => {
      exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const out = (stdout || stderr || '').trim();
        if (err) {
          reject(new Error(out || err.message));
          return;
        }
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

const cachedDependencyPreflight = createCachedDependencyPreflight(preflightBinaries);

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
    private readonly commandRunner: DocumentCommandRunner = runDocumentCommand,
    private readonly dependencyPreflight: DependencyPreflight = cachedDependencyPreflight,
    private readonly runtimeResolver: DocumentRuntimeResolver = resolveDocumentRuntime,
  ) {
    const desc = `Generates polished documents from markdown content.

EXAMPLES:
  Report: {format:"report", output_format:"pdf", title:"Q3 Report", author:"Me", content:"# Summary\\n\\nContent here..."}
  Slides: {format:"slides", output_format:"pptx", title:"Presentation", template_options:"editorial, navy and coral", content:"<!-- layout: cover -->\\n# Slide 1\\n\\n---\\n\\n<!-- layout: statement -->\\n# Slide 2\\n**42%** growth"}
  Letter: {format:"letter", output_format:"pdf", title:"Regarding...", author:"Me", content:"Body text..."}
  Resume: {format:"resume", output_format:"pdf", title:"My Resume", content:"## Experience\\n\\n- Job 1..."}
  Simple: {format:"article", output_format:"markdown", content:"# Hello World"}

PPTX VISUAL GRAMMAR: Start each slide with <!-- layout: cover|statement|split|timeline|quote|list|section|visual -->. Use ## headings for split, numbered lists for timeline, > for quote, and local Markdown images for visual. Put the deck art direction and colors in template_options (e.g. "navy and gold, editorial style"). If you skip layout hints, Otto auto-infers the best layout based on page position, content density, and visual patterns — early short pages become covers, data-heavy pages become lists with native text, sparse impact statements become statement pages, and closing pages with short text become statement. For data tables use | header | format. Mixed pages (text + single image) auto-select visual layout for best rendering.\n\nPPTX SMART HINTS: You can steer the renderer with 3 hints per slide — (1) a <!-- layout: xxx --> comment to force a specific visual style, (2) bold numbers like **42%** or **150万** on data pages to trigger native editable text with auto-sizing, and (3) pipe tables | for native PPT table objects that are selectable and searchable. The renderer automatically alternates between editorial and list styles on consecutive bullet pages to avoid visual monotony.

PPTX QUALITY BOUNDARY: This deterministic renderer is a speed fallback. For a high-aesthetic or flashy deck, load ppt-creator and build a topic-specific custom HTML/CSS/SVG canvas instead of presenting this fallback as premium work.

ENGINES: PPTX -> deterministic 1920x1080 local HTML -> local browser PNG screenshots -> bundled PptxGenJS packaging. Slide PDF/HTML -> Marp. Other PDF -> Typst or Pandoc. docx/html -> Pandoc.

DEPENDENCIES: PPTX needs a local Chrome/Edge/Chromium browser and never runs Python. Markdown needs none. Slide PDF/HTML need marp-cli; other formats may need typst or pandoc. External engines run a doctor preflight and fail loud with an install command if missing (never faking output). macOS: brew install typst pandoc; npm i -g @marp-team/marp-cli. Windows: winget install typst pandoc; npm i -g @marp-team/marp-cli.`;
    super(GenerateDocumentTool.Name, 'GenerateDocument', desc, Icon.Pencil,
      {
        type: Type.OBJECT,
        properties: {
          content: { type: Type.STRING, description: 'Markdown content. Slides: --- for page breaks, optional <!-- layout: xxx --> per page. Otto auto-infers layout from content position, density, images, and data patterns. Bold numbers (**42%**) + pipe tables trigger native editable text & table objects.' },
          format: { type: Type.STRING, enum: ['report','slides','letter','resume','article','table'], description: 'Document layout style' },
          output_format: { type: Type.STRING, enum: ['pdf','docx','html','markdown','pptx'], description: 'Output file format. Slides only: pdf, html, pptx.' },
          output_path: { type: Type.STRING, description: 'Output file path. Default: Desktop/generated_<ts>.<ext>' },
          title: { type: Type.STRING, description: 'Document title (appears in header/metadata)' },
          author: { type: Type.STRING, description: 'Author name (appears in metadata)' },
          template_options: { type: Type.STRING, description: 'Slides: art direction and palette (hex colors are honored). Other formats: extra rendering-engine options.' },
        },
        required: ['content','format','output_format'],
      },
      true,
      false,
      true,
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

  async execute(
    p: GenerateDocumentToolParams,
    signal: AbortSignal,
    updateOutput?: ProgressReporter,
  ): Promise<ToolResult> {
    const logLabel = 'generate_document.'+(p.output_format || p.format);
    console.time(logLabel);
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    const { content, format, output_format, title, template_options } = p;
    const trustedIdentity = this.config.getDocumentIdentity();
    const titleStr = title || 'Untitled';
    const authorStr = trustedIdentity?.name || '';
    const departmentStr = trustedIdentity?.department || '';
    const bylineStr = departmentStr && authorStr
      ? `${departmentStr} · ${authorStr}`
      : authorStr;
    const outPath = p.output_path || path.join(os.homedir(), 'Desktop', 'generated_'+Date.now()+'.'+output_format);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-doc-'));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const progress = new DocumentProgress(updateOutput);

    try {
      progress.step('read', '读取输入内容');
      if (format === 'slides') {
        await this.genSlides(
          content,
          output_format,
          outPath,
          tmpDir,
          titleStr,
          template_options || '',
          authorStr,
          departmentStr,
          signal,
          progress,
        );
      } else if (output_format === 'markdown') {
        progress.step('parse', '解析 Markdown 正文');
        progress.step('structure', '生成文档结构');
        progress.step('body', '生成 Markdown 正文');
        fs.writeFileSync(outPath, '# '+titleStr+'\n'+(bylineStr?'**'+bylineStr+'**\n':'')+'\n'+content);
        progress.step('export', '导出 Markdown 文件');
      } else if (output_format === 'docx') {
        await this.genDocx(
          content,
          outPath,
          tmpDir,
          titleStr,
          authorStr,
          departmentStr,
          format,
          signal,
          progress,
        );
      } else if (output_format === 'pdf' && ['report','article','letter','resume'].includes(format)) {
        await this.genTypst(content, format, outPath, tmpDir, titleStr, authorStr, bylineStr, signal, progress);
      } else {
        await this.genPandoc(content, outPath, tmpDir, titleStr, bylineStr, output_format, format, signal, progress);
      }

      const sz = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
      const label = path.basename(outPath)+' ('+format+', '+sz+' bytes)';
      progress.step('done', '生成完成');
      return {
        llmContent: 'generate_document OK: '+label+'\n'+progress.summary(),
        returnDisplay: 'generate_document OK: '+label+'\n\n'+progress.summary(),
      };
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
    templateOptions: string,
    author: string,
    department: string,
    signal: AbortSignal,
    progress: DocumentProgress,
  ): Promise<void> {
    progress.step('parse', '解析幻灯片 Markdown');
    const slides = normalizeSlidesMarkdown(content);
    progress.step('structure', '生成幻灯片结构');
    if (fmt === 'pptx') {
      await this.genPptx(
        slides,
        outPath,
        title,
        tmpDir,
        templateOptions,
        author,
        department,
        signal,
        progress,
      );
      return;
    }

    // PDF/HTML slides render via Marp. Fail loud if missing.
    progress.step('preflight', '预检 Marp 依赖');
    const missing = await this.dependencyPreflight(['marp']);
    if (missing) throw new Error('generate_document/slides needs marp: ' + missing);
    const mdFile = path.join(tmpDir, 'slides.md');
    progress.step('body', '生成幻灯片正文');
    fs.writeFileSync(
      mdFile,
      [
        '---',
        'marp: true',
        'theme: default',
        'paginate: true',
        `title: ${JSON.stringify(title)}`,
        ...(author ? [`author: ${JSON.stringify(author)}`] : []),
        ...(department ? [`company: ${JSON.stringify(department)}`] : []),
        '---',
        '',
        slides,
      ].join('\n'),
    );
    progress.step('export', `导出 ${fmt.toUpperCase()} 文件`);
    await this.commandRunner(
      'marp',
      [mdFile, '-o', outPath, '--allow-local-files'],
      { signal },
    );
  }

  private async genPptx(
    content: string,
    outPath: string,
    documentTitle: string,
    tmpDir: string,
    templateOptions: string,
    author: string,
    department: string,
    signal: AbortSignal,
    progress: DocumentProgress,
  ): Promise<void> {
    // The upstream NodeNext declaration exposes the constructor at runtime but
    // not as a constructable default-export type, so narrow it to the API used here.
    const PptxGenConstructor = pptxgen as unknown as new () => NativePptxPresentation;
    const presentation = new PptxGenConstructor();
    presentation.layout = 'LAYOUT_WIDE';
    presentation.author = author;
    presentation.company = department;
    presentation.subject = documentTitle;
    presentation.title = documentTitle;

    const baseTheme = this.resolveSlideTheme(templateOptions, documentTitle);

    progress.step('structure', '生成 PPTX 页面结构');
    const sections = content
      .split(/^\s*---\s*$/m)
      .map((sec) => this.parseSlideSection(sec, documentTitle))
      .filter((sec) => sec.title || sec.body.length > 0);

    if (sections.length === 0) {
      const slide = presentation.addSlide();
      slide.addText(documentTitle, { x: 1, y: 2, w: 11.333, h: 3, fontSize: 44, bold: true, align: 'center', color: '333333' });
      await presentation.writeFile({ fileName: outPath, compression: true });
      return;
    }

    for (let idx = 0; idx < sections.length; idx += 1) {
      if (signal.aborted) throw new Error('PPT 本地生成已取消');
      progress.step('body', `生成第 ${idx + 1}/${sections.length} 页`);
      const sec = sections[idx];
      const pgNum = String(idx + 1).padStart(2, '0');

      // Per-slide theme: pick light/dark based on content
      const slideTheme = this.pickSlideTheme(sec, idx, sections.length, baseTheme);

      // Native text slides: editable pptxgenjs objects (not pixel images)
      if (this.canUseNativeText(sec, idx, sections.length)) {
        this.renderNativeSlide(presentation, sec, idx, sections.length, slideTheme, pgNum);
        continue;
      }

      // Visual slides (cover, section, quote, images): HTML→PNG pipeline
      const htmlPath = path.join(tmpDir, 'slide-' + (idx + 1) + '.html');
      const imgPath = path.join(tmpDir, 'slide-' + (idx + 1) + '.png');
      fs.writeFileSync(htmlPath, this.buildSlideHtml(sec, idx, sections.length, slideTheme), 'utf8');
      await this.htmlRenderer.render({ htmlPath, outputPath: imgPath, width: 1920, height: 1080, signal });
      const slide = presentation.addSlide();
      slide.addImage({ path: imgPath, altText: sec.title || documentTitle, x: 0, y: 0, w: 13.333, h: 7.5 });
      if (sec.notes.length > 0) slide.addNotes(sec.notes.join('\n'));
    }

    progress.step('export', '写入 PPTX 文件');
    await presentation.writeFile({ fileName: outPath, compression: true });
  }

  /** Smart routing: decide if a slide should use native pptxgenjs or HTML→PNG. */
  private canUseNativeText(sec: ParsedSlideSection, index?: number, total?: number): boolean {
    const layout = sec.requestedLayout ?? this.inferSlideLayout(sec, index ?? 0, total);
    // Native objects are reserved for the two content-dense layouts they can
    // faithfully reproduce. Statement/timeline/split and explicit art
    // direction rely on the HTML composition and must not silently collapse
    // into the generic editable-text renderer.
    if (layout !== 'list' && layout !== 'editorial') return false;
    if (sec.requestedLayout) return false;
    // Images + quotes look better as styled HTML
    const hasImg = sec.body.some((l) => /^!\[[^\]]*\]\(.+\)$/.test(l.trim()));
    if (hasImg) return false;
    // Everything else benefits from native editable text
    return true;
  }

  /** Pick per-slide theme: dark for dramatic pages, light for readable data pages. */
  private pickSlideTheme(
    sec: ParsedSlideSection, index: number, total: number, base: SlideTheme,
  ): SlideTheme {
    const layout = sec.requestedLayout ?? this.inferSlideLayout(sec, index, total);
    const body = sec.body.map((l) => l.trim()).filter(Boolean);
    const visibleText = this.cleanInlineMarkdown(body.join(' ')).replace(/^[-*+>]\s+/gm, '').trim();
    const desc = `${body.slice(0, 3).join(' ')} ${visibleText}`.toLowerCase();

    const hasImg = body.some((l) => /^!\[[^\]]*\]\(.+\)$/.test(l));
    const hasTable = body.some((l) => /^\|.+\|$/.test(l));
    const hasBoldNums = /\*\*\d+[%％倍万亿]/.test(visibleText) || /\*\*[+-]?\d+\.?\d*/.test(visibleText);
    const isDataHeavy = hasTable || hasBoldNums;
    const isShortImpact = visibleText.length <= 80;

    // User explicitly requested dark/light in template_options → full deck respects it
    if (/深色|dark|ink/.test(desc) && !/浅色|light|明亮/.test(desc)) return this.makeDarkTheme(base);
    if (/浅色|light|明亮/.test(desc) && !/深色|dark|ink/.test(desc)) return this.makeLightTheme(base);

    // Per-slide intelligent pick
    if (layout === 'cover' || layout === 'section') return this.makeDarkTheme(base);
    if (layout === 'quote' || layout === 'visual') return this.makeDarkTheme(base);
    if (layout === 'statement' && isShortImpact) return this.makeDarkTheme(base);
    if (isDataHeavy) return this.makeLightTheme(base);
    if (hasImg) return this.makeDarkTheme(base);
    if (visibleText.length > 400) return this.makeLightTheme(base);
    if (layout === 'timeline' || layout === 'list') return this.makeLightTheme(base);

    return this.makeLightTheme(base);
  }

  /** Derive a dark variant while preserving the requested brand primary. */
  private makeDarkTheme(base: SlideTheme): SlideTheme {
    return {
      ...base,
      background: this.darkenColor(base.primary, 0.85),
      text: '#E8EDF2',
      surface: this.mixHexColors(base.primary, '#FFFFFF', 0.08),
      muted: this.mixHexColors('#E8EDF2', this.darkenColor(base.primary, 0.85), 0.55),
      coverBackground: base.primary,
      coverText: this.contrastText(base.primary),
      primary: base.primary,
      accent: base.accent,
      secondary: base.secondary,
    };
  }

  /** Derive a light variant: clean bright background. */
  private makeLightTheme(base: SlideTheme): SlideTheme {
    const bg = this.isNearBlack(base.primary) ? '#FFFFFF' : this.lightenColor(base.primary, 0.92);
    const txt = this.contrastText(this.isNearBlack(base.primary) ? '#FFFFFF' : bg);
    return {
      ...base,
      background: bg,
      text: txt,
      surface: this.mixHexColors(bg, txt, 0.06),
      muted: this.mixHexColors(txt, bg, 0.45),
      coverBackground: base.primary,
      coverText: this.contrastText(base.primary),
    };
  }

  private darkenColor(hex: string, factor: number): string {
    const rgb = this.hexToRgb(hex);
    return '#' + rgb.map((c) => Math.round(c * factor).toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  private lightenColor(hex: string, factor: number): string {
    const rgb = this.hexToRgb(hex);
    return '#' + rgb.map((c) => Math.round(c + (255 - c) * factor).toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  private isNearBlack(hex: string): boolean {
    const rgb = this.hexToRgb(hex);
    return rgb.reduce((s, c) => s + c, 0) < 80;
  }

  /** Accent bar color: either a user-provided hex or the theme primary. */
  private accentBarColor(sec: ParsedSlideSection, theme: SlideTheme): string {
    const barMatch = sec.body
      .map((l) => l.trim())
      .filter(Boolean)
      .find((l) => /^\s*<!--\s*(?:bar|accent)\s*:\s*(#[0-9a-f]{6}|[a-z]+)\s*-->/i.test(l));
    if (barMatch) {
      const m = barMatch.match(/:\s*(#[0-9a-f]{6})\b/i);
      if (m) return m[1].toUpperCase();
    }
    return theme.accent;
  }

  /** Render a text slide with native pptxgenjs objects (editable, design-rich). */
  private renderNativeSlide(
    pres: NativePptxPresentation, sec: ParsedSlideSection, _index: number, total: number,
    theme: SlideTheme, pgNum: string,
  ): void {
    const slide = pres.addSlide();
    slide.background = { color: theme.background.replace('#', '') };
    const isLight = this.isLightTheme(theme);
    const barColor = this.accentBarColor(sec, theme);
    const primaryColor = isLight ? this.mixHexColors(barColor, theme.background, 0.15) : barColor;

    // ── accent bar (left vertical stripe) ──
    slide.addShape(pres.ShapeType?.rect ?? 'rect', {
      x: 0, y: 0, w: 0.12, h: 7.5,
      fill: { color: barColor.replace('#', '') },
      line: { color: barColor.replace('#', ''), width: 0 },
    });

    // ── title ──
    const title = this.stripMarkdown(sec.title);
    if (title) {
      const titleColor = isLight ? this.darkenColor(primaryColor, 0.55) : '#FAFAFA';
      slide.addText(title, {
        x: 0.9, y: 0.5, w: 10.5, h: 0.95,
        fontSize: 34, bold: true, color: titleColor.replace('#', ''),
        fontFace: 'PingFang SC', align: 'left',
      });

      // accent underline under title
      slide.addShape(pres.ShapeType?.rect ?? 'rect', {
        x: 0.9, y: 1.55, w: 1.6, h: 0.06,
        fill: { color: barColor.replace('#', '') },
        line: { color: barColor.replace('#', ''), width: 0 },
      });
    }

    let y = title ? 1.9 : 0.6;
    const parsed = this.parseNativeSlideBody(sec.body, theme);

    // ── tables ──
    for (const tb of parsed.tables) {
      const headerBg = isLight ? this.mixHexColors(barColor, '#FFFFFF', 0.82) : barColor;
      const headerText = isLight ? theme.text : '#FFFFFF';
      const rowCount = tb.rows.length;
      const hPerRow = Math.min(0.42, (5.8 - y) / Math.max(1, rowCount + 1));
      const hrs: NativePptxTableRow = tb.headers.map((h: string) => ({
        text: h,
        options: {
          bold: true, fontSize: 12, color: headerText.replace('#', ''),
          fill: { color: headerBg.replace('#', '') },
          fontFace: 'PingFang SC' as const,
        },
      }));
      const drs: NativePptxTableRow[] = tb.rows.map((row: string[]) =>
        row.map((cell: string) => ({
          text: cell,
          options: {
            fontSize: 11,
            color: theme.text.replace('#', ''),
            fontFace: 'PingFang SC' as const,
          },
        })),
      );
      slide.addTable([hrs, ...drs], {
        x: 0.9, y, w: 11.4,
        border: { type: 'solid', pt: 0.5, color: theme.surface.replace('#', '') },
        rowH: hPerRow,
      });
      y += (rowCount + 1) * hPerRow + 0.25;
    }

    // ── text blocks ──
    for (const blk of parsed.texts) {
      if (y > 6.4) break;

      const isHeading = blk.bold && blk.fontSize >= 18;
      const isBulletBlock = blk.isBullet;

      if (isHeading) {
        // Section divider in text: accent number + top border
        slide.addShape(pres.ShapeType?.rect ?? 'rect', {
          x: 0.9, y: y - 0.05, w: 0.26, h: 0.04,
          fill: { color: barColor.replace('#', '') },
          line: { color: barColor.replace('#', ''), width: 0 },
        });
        y += 0.08;
      }

      const blockColor = isHeading
        ? this.isLightTheme(theme)
          ? this.darkenColor(primaryColor, 0.45)
          : '#F0F4F8'
        : (blk.color || theme.text);

      const textRuns: NativePptxTextRun[] = blk.lines.map((ln: string) => ({
          text: ln,
          options: {
            fontSize: blk.fontSize || 14,
            color: blockColor.replace('#', ''),
            bold: blk.bold ?? false,
            fontFace: 'PingFang SC' as const,
            bullet: isBulletBlock ? {
              code: '\u2022',
              color: barColor.replace('#', ''),
            } : undefined,
            breakType: 'none' as const,
          },
        }));
      const textOptions: NativePptxTextOptions = {
          x: 0.9 + (blk.indent || 0) * 1.4,
          y,
          w: 11.4 - (blk.indent || 0) * 1.4,
          h: isHeading ? 0.48 : Math.min(4.5, blk.lines.length * 0.40),
          valign: isHeading ? 'middle' : 'top',
          lineSpacingMultiple: isHeading ? 1.15 : 1.38,
        };
      slide.addText(textRuns, textOptions);

      y += (isHeading ? 0.58 : Math.min(4.5, blk.lines.length * 0.40)) + 0.12;
    }

    // ── footer ──
    const footerStr = `${pgNum} / ${String(total).padStart(2, '0')}`;
    const footerColor = isLight
      ? this.mixHexColors(theme.text, '#FFFFFF', 0.55)
      : this.mixHexColors('#E0E0E0', theme.background, 0.55);
    slide.addText(footerStr, {
      x: 0.9, y: 6.9, w: 2.0, h: 0.35,
      fontSize: 10, color: footerColor.replace('#', ''),
      align: 'left', fontFace: 'PingFang SC',
    });

    if (sec.notes.length > 0) slide.addNotes(sec.notes.join('\n'));
  }

  private isLightTheme(theme: SlideTheme): boolean {
    const bg = theme.background;
    const rgb = this.hexToRgb(bg);
    return (rgb[0] + rgb[1] + rgb[2]) / 3 > 128;
  }

  /** Parse slide body into native text blocks and PPT tables. */
  private parseNativeSlideBody(lines: string[], theme: SlideTheme): {
    texts: NativeSlideTextBlock[];
    tables: NativeSlideTable[];
  } {
    const result: { texts: NativeSlideTextBlock[]; tables: NativeSlideTable[] } = {
      texts: [],
      tables: [],
    };

    let cur: NativeSlideTextBlock | null = null;
    let inTable = false;
    let tblHeaders: string[] = [];
    let tblRows: string[][] = [];

    for (const rawLine of lines) {
      const ln = rawLine.trim();
      if (!ln) { cur = null; continue; }

      // Table row
      if (/^\|.+\\|$/.test(ln)) {
        if (ln.includes('---')) continue;
        inTable = true;
        const cells = ln.split('|').slice(1, -1).map((c: string) => this.stripMarkdown(c.trim()));
        if (tblHeaders.length === 0) { tblHeaders = cells; } else { tblRows.push(cells); }
        continue;
      }

      // Flush buffered table
      if (inTable && tblHeaders.length > 0) {
        result.tables.push({ headers: tblHeaders, rows: tblRows });
        tblHeaders = []; tblRows = []; inTable = false;
      }

      const hd = ln.match(/^#{2,6}\s+(.+)$/);
      if (hd) { cur = null; result.texts.push({ lines: [this.stripMarkdown(hd[1])], fontSize: 18, bold: true, color: theme.primary }); continue; }

      const bul = ln.match(/^[-*+]\s+(.+)$/);
      const num = ln.match(/^\d+[.)]\s+(.+)$/);
      if (bul || num) {
        const txt = this.stripMarkdown((bul || num)![1]);
        if (!cur || !cur.isBullet) { cur = { lines: [txt], fontSize: 13, color: theme.text, isBullet: true }; result.texts.push(cur); }
        else { cur.lines.push(txt); }
        continue;
      }

      const qt = ln.match(/^>\s*(.+)$/);
      if (qt) { cur = null; result.texts.push({ lines: [this.stripMarkdown(qt[1])], fontSize: 15, indent: 1, color: theme.muted }); continue; }

      const cl = this.stripMarkdown(ln);
      if (cl) {
        if (!cur || cur.isBullet) { cur = { lines: [cl], fontSize: 13, color: theme.text }; result.texts.push(cur); }
        else { cur.lines.push(cl); }
      }
    }

    if (inTable && tblHeaders.length > 0) result.tables.push({ headers: tblHeaders, rows: tblRows });
    return result;
  }

  /** Strip markdown formatting for native PPT text. */
  private stripMarkdown(text: string): string {
    return text
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/, '')
      .trim();
  }

  private buildSlideHtml(
    section: ParsedSlideSection,
    index: number,
    total: number,
    theme: SlideTheme,
  ): string {
    const layout = this.inferSlideLayout(section, index, total);
    const density = this.getSlideDensity(section.body);
    const title = this.escapeHtml(section.title);
    const body = this.renderSlideBodyHtml(section.body, layout);
    const pageNumber = String(index + 1).padStart(2, '0');
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=1920,height=1080,initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 1920px; height: 1080px; margin: 0; overflow: hidden; }
    body {
      position: relative;
      background: var(--background);
      color: var(--text);
      font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Inter, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body::before, body::after { content: ""; position: absolute; pointer-events: none; }
    .deck { position: relative; width: 100%; height: 100%; padding: 76px 112px 66px; z-index: 1; }
    .composition { height: 100%; padding-top: 68px; }
    .eyebrow { display: block; margin-bottom: 24px; color: var(--primary); font-size: 18px; font-weight: 800; letter-spacing: .13em; }
    h1 {
      max-width: 1510px; margin: 0; font-size: 66px; line-height: 1.08;
      letter-spacing: -0.035em; font-weight: 760;
      text-wrap: balance;
    }
    .content {
      max-width: 1540px; margin-top: 54px; color: var(--text);
      font-size: 34px; line-height: 1.42;
    }
    .content p { max-width: 1260px; margin: 0 0 24px; }
    .content h2 { margin: 0 0 20px; color: var(--primary); font-size: 32px; line-height: 1.2; }
    .content ul, .content ol { margin: 0; padding: 0; list-style: none; }
    .content li { margin: 0; }
    .content strong { color: var(--primary); font-weight: 820; }
    .content blockquote {
      position: relative; margin: 0; padding: 0 0 0 72px; max-width: 1450px;
      border-left: 12px solid var(--accent); color: var(--text); font-weight: 650;
    }
    code { padding: .08em .28em; background: var(--surface); font-family: ui-monospace, monospace; font-size: .84em; }
    .visual-frame { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--surface); }
    .visual-image { display: block; width: 100%; height: 100%; object-fit: cover; }
    .visual-frame figcaption { position: absolute; left: 24px; bottom: 18px; color: var(--muted); font-size: 17px; }
    .footer {
      position: absolute; right: 112px; bottom: 52px; color: var(--muted);
      font-size: 17px; font-weight: 750; letter-spacing: .12em;
    }

    body[data-layout="cover"], body[data-layout="section"] { background: var(--cover-background); color: var(--cover-text); }
    body[data-layout="cover"] .deck { padding: 86px 118px 80px; }
    body[data-layout="cover"] .composition { display: flex; flex-direction: column; justify-content: flex-end; padding-bottom: 90px; }
    body[data-layout="cover"] .eyebrow { color: var(--accent); }
    body[data-layout="cover"] h1 { max-width: 1530px; font-size: 108px; line-height: 1.02; color: var(--cover-text); }
    body[data-layout="cover"] .content { max-width: 1180px; margin-top: 42px; color: var(--cover-muted); font-size: 34px; }
    body[data-layout="cover"]::before {
      width: 980px; height: 980px; right: -230px; top: -410px; border-radius: 50%;
      background: radial-gradient(circle at center, var(--accent) 0, transparent 68%); opacity: .42;
    }
    body[data-layout="cover"]::after {
      width: 760px; height: 1200px; left: 190px; top: -180px;
      border-left: 3px solid var(--accent); transform: rotate(23deg); opacity: .42;
    }

    body[data-layout="section"] .composition { display: flex; align-items: center; padding: 0 120px 20px; }
    body[data-layout="section"] h1 { max-width: 1320px; color: var(--cover-text); font-size: 92px; }
    body[data-layout="section"] .content { display: none; }
    body[data-layout="section"]::before {
      width: 1160px; height: 480px; left: -210px; bottom: -250px;
      background: var(--accent); transform: skewX(-28deg); opacity: .24;
    }

    body[data-layout="statement"] .composition {
      display: grid; grid-template-columns: minmax(0, .82fr) minmax(0, 1.18fr);
      gap: 110px; align-items: center; padding-top: 10px;
    }
    body[data-layout="statement"] h1 { font-size: 58px; }
    body[data-layout="statement"] .content { margin: 0; font-size: 52px; line-height: 1.16; }
    body[data-layout="statement"] .content strong { display: block; margin-bottom: 18px; font-size: 148px; line-height: .88; letter-spacing: -.055em; }
    body[data-layout="statement"]::before {
      width: 720px; height: 720px; right: 80px; bottom: -430px; border-radius: 50%;
      border: 76px solid var(--accent); opacity: .14;
    }

    body[data-layout="list"] .content ul,
    body[data-layout="editorial"] .content ul {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 72px; counter-reset: item;
    }
    body[data-layout="list"] .content li,
    body[data-layout="editorial"] .content li {
      min-height: 112px; padding: 24px 10px 24px 72px; border-top: 2px solid var(--surface);
      position: relative; counter-increment: item;
    }
    body[data-layout="list"] .content li::before,
    body[data-layout="editorial"] .content li::before {
      content: "0" counter(item); position: absolute; left: 0; top: 27px;
      color: var(--accent); font-size: 18px; font-weight: 850; letter-spacing: .08em;
    }
    body[data-layout="editorial"] .composition { padding-left: 160px; }
    body[data-layout="editorial"] h1 { max-width: 1320px; }

    body[data-layout="timeline"] .content { max-width: none; margin-top: 78px; }
    body[data-layout="timeline"]::before {
      width: calc(100% - 224px); height: 2px; left: 112px; bottom: 150px;
      background: linear-gradient(90deg, var(--primary), var(--accent), transparent); opacity: .36;
    }
    body[data-layout="timeline"] .content ol {
      display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 34px; counter-reset: step;
    }
    body[data-layout="timeline"] .content li {
      min-height: 250px; padding: 90px 24px 24px 0; border-top: 8px solid var(--primary);
      position: relative; counter-increment: step; font-size: 29px;
    }
    body[data-layout="timeline"] .content li::before {
      content: counter(step); position: absolute; top: 22px; left: 0; color: var(--accent);
      font-size: 42px; line-height: 1; font-weight: 850;
    }

    body[data-layout="split"] .content { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 54px; max-width: none; }
    body[data-layout="split"]::before {
      width: 620px; height: 620px; right: -330px; top: 230px; border-radius: 50%;
      background: var(--secondary); opacity: .12;
    }
    body[data-layout="split"] .panel { min-height: 330px; padding: 32px 10px 0; border-top: 8px solid var(--primary); }
    body[data-layout="split"] .panel:nth-child(2) { border-color: var(--accent); }
    body[data-layout="split"] .panel:nth-child(3) { border-color: var(--secondary); }
    body[data-layout="split"] .panel h2 { font-size: 34px; }
    body[data-layout="split"] .panel .panel-body { margin-top: 26px; font-size: 28px; color: var(--muted); }
    body[data-layout="split"] .panel .panel-body p { margin-bottom: 16px; }

    body[data-layout="quote"] .composition { padding: 108px 90px 0 170px; }
    body[data-layout="quote"] h1 { color: var(--muted); font-size: 34px; letter-spacing: 0; }
    body[data-layout="quote"] .content { margin-top: 62px; font-size: 64px; line-height: 1.22; }
    body[data-layout="quote"]::before {
      content: "“"; left: 92px; top: 120px; color: var(--accent); opacity: .16;
      font-family: Georgia, serif; font-size: 560px; line-height: 1;
    }

    body[data-layout="visual"] .composition {
      display: grid; grid-template-columns: minmax(0, .78fr) minmax(0, 1.22fr);
      gap: 88px; align-items: stretch; padding-top: 54px; padding-bottom: 64px;
    }
    body[data-layout="visual"] h1 { font-size: 58px; align-self: center; }
    body[data-layout="visual"] .content { height: 700px; margin: 0; }
    body[data-layout="visual"] .visual-frame { position: relative; }

    body[data-density="compact"] .content { font-size: 29px; line-height: 1.34; }
    body[data-density="dense"] .content { font-size: 25px; line-height: 1.28; }
    body[data-density="dense"] .content li { min-height: 86px; padding-top: 16px; padding-bottom: 16px; }

    body[data-style="advertising"] h1 { font-weight: 900; letter-spacing: -.05em; }
  </style>
</head>
<body
  data-slide-index="${index + 1}"
  data-layout="${layout}"
  data-density="${density}"
  data-style="${theme.style}"
  style="--primary: ${theme.primary}; --secondary: ${theme.secondary}; --accent: ${theme.accent}; --background: ${theme.background}; --text: ${theme.text}; --surface: ${theme.surface}; --muted: ${theme.muted}; --cover-background: ${theme.coverBackground}; --cover-text: ${theme.coverText}; --cover-muted: ${this.mixHexColors(theme.coverText, theme.coverBackground, 0.34)}"
>
  <main class="deck">
    <div class="composition">
      <div class="title-block">
        <span class="eyebrow">${pageNumber} / ${String(total).padStart(2, '0')}</span>
        <h1>${title}</h1>
      </div>
      <section class="content">${body}</section>
    </div>
  </main>
  <footer class="footer">${pageNumber}</footer>
</body>
</html>`;
  }

  private renderSlideBodyHtml(lines: string[], layout: SlideLayout): string {
    if (layout === 'split') {
      const panels: Array<{ title: string; lines: string[] }> = [];
      let current: { title: string; lines: string[] } | undefined;
      for (const rawLine of lines) {
        const heading = rawLine.trim().match(/^#{2,6}\s+(.+)$/);
        if (heading) {
          current = { title: heading[1], lines: [] };
          panels.push(current);
        } else if (rawLine.trim()) {
          if (!current) {
            current = { title: '重点', lines: [] };
            panels.push(current);
          }
          current.lines.push(rawLine);
        }
      }
      return panels.slice(0, 3).map((panel) => (
        `<article class="panel"><h2>${this.renderInlineMarkdown(panel.title)}</h2>`
        + `<div class="panel-body">${this.renderSlideBodyHtml(panel.lines, 'editorial')}</div></article>`
      )).join('');
    }

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

      const image = line.match(/^!\[([^\]]*)\]\((.+)\)$/);
      if (image) {
        closeList();
        const source = this.escapeHtml(this.resolveImageSource(image[2].trim()));
        const alt = this.escapeHtml(image[1].trim() || 'PPT visual');
        output.push(
          `<figure class="visual-frame"><img class="visual-image" src="${source}" alt="${alt}">`
          + (image[1].trim() ? `<figcaption>${alt}</figcaption>` : '')
          + '</figure>',
        );
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

  private resolveImageSource(source: string): string {
    if (/^(?:https?:|file:|data:)/i.test(source)) return source;
    const resolved = path.isAbsolute(source) ? source : path.resolve(source);
    return pathToFileURL(resolved).href;
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
  ): ParsedSlideSection {
    const layoutMatch = section.match(
      /<!--\s*(?:layout|版式)\s*:\s*(cover|section|statement|list|editorial|split|timeline|quote|visual)\s*-->/i,
    );
    const requestedLayout = layoutMatch?.[1].toLowerCase() as SlideLayout | undefined;
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
    return { title, body, notes, requestedLayout };
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

  private inferSlideLayout(section: ParsedSlideSection, index: number, total?: number): SlideLayout {
    if (section.requestedLayout) return section.requestedLayout;

    const body = section.body.map((line) => line.trim()).filter(Boolean);
    const visibleText = this.cleanInlineMarkdown(body.join(' ')).replace(/^[-*+>]\s+/gm, '').trim();
    const lineCount = body.length;
    const textLen = visibleText.length;
    const totalPages = total ?? index + 1;

    // Inferred page role
    const isFirstPage = index === 0;
    const isLastPage = index === totalPages - 1 && totalPages > 1;

    // Content type detection
    const hasImage = body.some((l) => /^!\[[^\]]*\]\(.+\)$/.test(l));
    const imageCount = body.filter((l) => /^!\[[^\]]*\]\(.+\)$/.test(l)).length;
    const hasQuote = body.some((l) => /^>\s/.test(l));
    const orderedItems = body.filter((l) => /^\d+[.)]\s+/.test(l)).length;
    const bulletItems = body.filter((l) => /^[-*+]\s+/.test(l)).length;
    const subheadings = body.filter((l) => /^#{2,6}\s+/.test(l)).length;
    const hasTable = body.some((l) => /^\|.+\|$/.test(l));
    const hasBoldNumbers = /\*\*\d+[%％倍万亿]/.test(visibleText) || /\*\*[+-]?\d+\.?\d*/.test(visibleText);
    const isDataHeavy = hasTable || (hasBoldNumbers && lineCount >= 3);
    const isSparse = lineCount <= 2 && textLen <= 90;

    // Empty slide → section divider
    if (lineCount === 0) return 'section';

    // Data-heavy pages: use native text rendering with tables
    if (isDataHeavy && !hasImage && !hasQuote) return 'list';

    // Cover: exactly the first page. Treating a sparse second page as another
    // cover produces duplicate covers and masks the intended statement layout.
    if (isFirstPage) return 'cover';

    // Images → visual layout
    if (hasImage && !isDataHeavy) {
      if (imageCount >= 2) return 'visual';
      if (textLen <= 150) return 'visual';
      // Text + single image: still visual for best rendering
      return 'visual';
    }

    // Quote
    if (hasQuote && !hasTable && textLen <= 300) return 'quote';

    // Statement: standalone impactful sentence
    if (isSparse && !isFirstPage && !hasImage) return 'statement';

    // Timeline: numbered sequence (3-5 items)
    if (orderedItems >= 3 && orderedItems <= 5) return 'timeline';

    // Split: multiple subheadings (2-3 clear sections)
    if (subheadings >= 2 && subheadings <= 3) return 'split';

    // Content-heavy presentation slides: alternate editorial/list for variety
    const isSecondHalf = index > totalPages / 2;
    if (bulletItems >= 3) return isSecondHalf ? 'list' : 'editorial';
    if (bulletItems >= 1 && lineCount <= 5) return 'editorial';

    // Heavy text, late in deck: use list for scannability
    if (textLen > 500 && isSecondHalf) return 'list';

    // Closing page
    if (isLastPage && textLen <= 200) return 'statement';

    return 'editorial';
  }

  private getSlideDensity(lines: string[]): 'airy' | 'compact' | 'dense' {
    const visibleLength = this.cleanInlineMarkdown(lines.join(' ')).length;
    if (visibleLength > 320 || lines.filter((line) => line.trim()).length > 10) return 'dense';
    if (visibleLength > 190 || lines.filter((line) => line.trim()).length > 6) return 'compact';
    return 'airy';
  }

  private resolveSlideTheme(templateOptions: string, documentTitle: string): SlideTheme {
    const descriptor = `${templateOptions} ${documentTitle}`.toLowerCase();
    const style: SlideTheme['style'] = /商务|business|corporate/.test(descriptor)
      ? 'business'
      : /扁平|flat/.test(descriptor)
        ? 'flat'
        : /旅游|travel/.test(descriptor)
          ? 'travel'
          : /广告|advertising|marketing/.test(descriptor)
            ? 'advertising'
            : /动漫|anime|漫画/.test(descriptor)
              ? 'anime'
              : 'editorial';

    const explicitColors = Array.from(
      new Set((templateOptions.match(/#[0-9a-f]{6}\b/gi) || []).map((color) => color.toUpperCase())),
    );
    const palettes = [
      ['#0F2940', '#3876A0', '#E8593D', '#FFFFFF', '#15202B'],
      ['#1A3C2E', '#4D8C6E', '#D97C3B', '#FFFDFA', '#1C2F26'],
      ['#3C1F5C', '#7B5EA7', '#C4483A', '#FEFCFD', '#1D1329'],
      ['#7B2D1F', '#B8705E', '#225B5F', '#FFF8F5', '#201814'],

      ['#F5F7FA', '#4A7FB5', '#D8452B', '#FFFFFF', '#1E293B'],
      ['#FCFAF3', '#3C6E4F', '#C66231', '#FFFFFF', '#1E2620'],
      ['#FAF8FC', '#6B4C8E', '#BE3D31', '#FFFFFF', '#1D1926'],
      ['#FEF8F4', '#2D6B7A', '#B8422A', '#FFFFFF', '#1A1817'],
    ];
    const keywordPalette = /深色|dark|黑色/.test(descriptor)
      ? ['#1E1E1E', '#3D3D3D', '#00D9FF', '#121212', '#E0E0E0']
      : /绿色|green/.test(descriptor)
        ? ['#2E7D32', '#81C784', '#FFC107', '#F1F8E9', '#1B4332']
        : /红色|red/.test(descriptor)
          ? ['#C62828', '#EF5350', '#FFD54F', '#FFF5F5', '#7F1D1D']
          : /紫色|purple/.test(descriptor)
            ? ['#6A1B9A', '#BA68C8', '#26C6DA', '#FAF5FF', '#4A1259']
            : /橙色|orange/.test(descriptor)
              ? ['#E65100', '#FFB74D', '#00ACC1', '#FFF8E1', '#7C2D12']
              : /蓝色|blue/.test(descriptor)
                ? ['#1565C0', '#42A5F5', '#FF6B35', '#F5F9FF', '#1A365D']
                : undefined;
    const titleHash = Array.from(documentTitle).reduce(
      (hash, character) => ((hash * 31) + character.codePointAt(0)!) >>> 0,
      7,
    );
    const prefersDark = /深色|dark|黑色|ink/.test(descriptor);
    const prefersLight = /浅色|light|白色|明亮/.test(descriptor);
    const palette =
      explicitColors.length >= 5
        ? explicitColors.slice(0, 5)
        : keywordPalette
          ? keywordPalette
          : prefersDark
            ? palettes[titleHash % 4]
            : prefersLight
              ? palettes[4 + (titleHash % 4)]
              : palettes[4 + (titleHash % 4)];
    const [primary, secondary, accent, background, text] = palette;
    const coverBackground = this.contrastRatio(primary, '#FFFFFF') >= 4.5
      ? primary
      : text;
    const coverText = this.contrastText(coverBackground);

    return {
      style,
      primary,
      secondary,
      accent,
      background,
      text,
      surface: this.mixHexColors(background, text, 0.10),
      muted: this.mixHexColors(text, background, 0.40),
      coverBackground,
      coverText,
    };
  }

  private mixHexColors(first: string, second: string, secondWeight: number): string {
    const a = this.hexToRgb(first);
    const b = this.hexToRgb(second);
    const weight = Math.max(0, Math.min(1, secondWeight));
    return '#' + [0, 1, 2].map((channel) => (
      Math.round(a[channel] * (1 - weight) + b[channel] * weight)
        .toString(16)
        .padStart(2, '0')
    )).join('').toUpperCase();
  }

  private contrastText(background: string): string {
    return this.contrastRatio(background, '#FFFFFF') >= 4.5 ? '#FFFFFF' : '#111827';
  }

  private contrastRatio(first: string, second: string): number {
    const luminance = (color: string) => {
      const channels = this.hexToRgb(color).map((value) => {
        const normalized = value / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : Math.pow((normalized + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  private hexToRgb(color: string): [number, number, number] {
    const normalized = color.replace('#', '').padEnd(6, '0').slice(0, 6);
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ];
  }
  private async genTypst(
    content: string,
    format: string,
    outPath: string,
    tmpDir: string,
    title: string,
    author: string,
    byline: string,
    signal: AbortSignal,
    progress: DocumentProgress,
  ): Promise<void> {
    // Doctor preflight: typst-rendered PDFs (report/article/letter/resume) need typst.
    progress.step('preflight', '预检 Typst 依赖');
    const missing = await this.dependencyPreflight(['typst']);
    if (missing) throw new Error('generate_document (' + format + ' -> pdf) needs typst: ' + missing);
    progress.step('parse', '解析 Markdown 正文');
    const typFile = path.join(tmpDir, 'doc.typ');
    progress.step('structure', '生成 Typst 文档结构');
    fs.writeFileSync(
      typFile,
      this.md2typst(content, format, title, author, byline),
    );
    progress.step('body', '生成 PDF 正文');
    progress.step('export', '导出 PDF 文件');
    await this.commandRunner('typst', ['compile', typFile, outPath], { signal });
  }
  private async genPandoc(
    content: string,
    outPath: string,
    tmpDir: string,
    title: string,
    byline: string,
    fmt: string,
    format: string,
    signal: AbortSignal,
    progress: DocumentProgress,
  ): Promise<void> {
    // Doctor preflight: docx/html and table PDFs render via pandoc. Fail loud if missing.
    progress.step('preflight', '预检 Pandoc 依赖');
    const missing = await this.dependencyPreflight(['pandoc']);
    if (missing) throw new Error('generate_document (' + format + ' -> ' + fmt + ') needs pandoc: ' + missing);
    progress.step('parse', '解析 Markdown 正文');
    const mdFile = path.join(tmpDir, 'doc.md');
    progress.step('structure', '生成 Pandoc 文档结构');
    fs.writeFileSync(mdFile, '# '+title+'\n'+(byline?'**'+byline+'**\n':'')+'\n'+content);
    const args = [mdFile, '-o', outPath, '-f', 'markdown', '-t', fmt, '--standalone'];
    if (format === 'report') args.push('--toc', '--number-sections');
    progress.step('body', '生成文档正文');
    progress.step('export', `导出 ${fmt.toUpperCase()} 文件`);
    await this.commandRunner('pandoc', args, { signal });
  }

  private async genDocx(
    content: string,
    outPath: string,
    tmpDir: string,
    title: string,
    author: string,
    department: string,
    format: string,
    signal: AbortSignal,
    progress: DocumentProgress,
  ): Promise<void> {
    progress.step('preflight', '预检 Python 公文依赖');
    const missing = await this.dependencyPreflight(['python3', 'python-docx', 'jinja2', 'markdown']);
    if (missing) throw new Error('generate_document (' + format + ' -> docx) needs doc-writer runtime: ' + missing);
    const script = findBundledDocWriterScript();
    if (!script) throw new Error('generate_document docx needs bundled doc-writer script: create_docx.py not found');

    progress.step('parse', '解析 Markdown 正文');
    const mdFile = path.join(tmpDir, 'doc.md');
    progress.step('structure', '生成 Word 公文结构');
    const frontMatter = [
      '---',
      `title: ${JSON.stringify(title)}`,
      author ? `author: ${JSON.stringify(author)}` : '',
      department ? `department: ${JSON.stringify(department)}` : '',
      department && author
        ? `signature_unit: ${JSON.stringify(`${department} · ${author}`)}`
        : '',
      'toc: false',
      '---',
      '',
    ].filter(Boolean).join('\n');
    fs.writeFileSync(mdFile, frontMatter + content, 'utf8');
    progress.step('body', '生成 Word 正文');
    const python = this.runtimeResolver('python');
    progress.step('export', '导出 DOCX 文件');
    const pythonEnvironment = buildBundledPythonEnvironment(python);
    if (author) pythonEnvironment.OTTO_DOCUMENT_AUTHOR = author;
    if (department) pythonEnvironment.OTTO_DOCUMENT_DEPARTMENT = department;
    await this.commandRunner(
      python.executable,
      [script, mdFile, outPath],
      { signal, env: pythonEnvironment },
    );
  }

  private md2typst(
    md: string,
    format: string,
    title: string,
    author: string,
    byline: string,
  ): string {
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
    const signature = byline
      ? '\n\n#align(right)[#text(size: 9pt, fill: rgb("#666666"))['+this.te(byline)+']]\n'
      : '';
    return preamble + '\n' + s + signature;
  }
  private te(s: string): string { return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,' '); }
}

class DocumentProgress {
  private readonly entries: Array<{ stage: string; label: string }> = [];

  constructor(private readonly updateOutput?: ProgressReporter) {}

  step(stage: string, label: string): void {
    this.entries.push({ stage, label });
    this.updateOutput?.(this.summary());
  }

  summary(): string {
    return [
      '公文生成进度：',
      ...this.entries.map((entry, index) =>
        `${index + 1}. ${entry.label}`,
      ),
    ].join('\n');
  }
}
