/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Web Automation - Browser automation for OA/ERP/web scraping.
 * Uses Playwright (cross-platform, Chromium/Firefox/WebKit).
 *
 * Handles: login, navigate, fill forms, click, scrape tables/text, screenshot.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { executeAutomationProcess } from './automation-process.js';
import { DoctorService } from '../services/doctor.js';

export interface WebAutomationToolParams {
  action: 'navigate' | 'fill' | 'click' | 'scrape' | 'screenshot' | 'run_script' | 'wait' | 'list_tabs' | 'extract_table';
  /** URL to navigate to */
  url?: string;
  /** CSS selector for fill/click/wait/scrape */
  selector?: string;
  /** Text to type into a field */
  value?: string;
  /** For scrape: what to extract ('text', 'html', 'href', 'src') */
  extract?: 'text' | 'html' | 'href' | 'src' | 'all';
  /** For fill: clear field first (default true) */
  clear_first?: boolean;
  /** For click: wait for navigation after click */
  wait_for_navigation?: boolean;
  /** Screenshot output path */
  output_path?: string;
  /** Full page screenshot (default false = viewport only) */
  full_page?: boolean;
  /** Wait timeout in ms (default 10000) */
  timeout_ms?: number;
  /** Custom JS script to execute on the page (for run_script) */
  script?: string;
  /** Browser engine: chromium (default), firefox, webkit */
  browser?: 'chromium' | 'firefox' | 'webkit';
}

export class WebAutomationTool extends BaseTool<WebAutomationToolParams, ToolResult> {
  static readonly Name: string = 'web_automation';

  /**
   * DoctorService 只读复用：真正启动浏览器前先确认 playwright 就绪。
   * 注意 playwright 走 node 模块解析（不是 PATH 二进制）——本机全局装了二进制但
   * node_modules 里没有时，应判为「缺失」。可注入以便测试。
   */
  constructor(
    private readonly config: Config,
    private readonly doctor: DoctorService = new DoctorService(),
    private readonly processExecutor: typeof executeAutomationProcess =
      executeAutomationProcess,
  ) {
    const desc = `Browser automation via Playwright for OA/ERP/web scraping.

EXAMPLES:
  Navigate: {action:"navigate", url:"https://oa.company.com/login"}
  Fill: {action:"fill", selector:"#username", value:"zhangxue"}
  Fill password: {action:"fill", selector:"#password", value:"xxx"}
  Click: {action:"click", selector:"#login-btn", wait_for_navigation:true}
  Scrape text: {action:"scrape", selector:".report-table", extract:"text"}
  Extract table: {action:"extract_table", selector:"table.data"}
  Screenshot: {action:"screenshot", output_path:"~/Desktop/page.png", full_page:true}
  Run JS: {action:"run_script", script:"return document.title"}
  Wait: {action:"wait", selector:"#dashboard", timeout_ms:15000}

DEPENDENCIES: npx playwright install chromium (one-time setup)
CROSS-PLATFORM: Works identically on macOS, Windows, Linux.`;

    super(WebAutomationTool.Name, 'WebAutomation', desc, Icon.Globe,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            description: 'Browser action to perform',
            enum: ['navigate', 'fill', 'click', 'scrape', 'screenshot', 'run_script', 'wait', 'list_tabs', 'extract_table'],
          },
          url: { type: Type.STRING, description: 'URL to navigate to (for navigate action)' },
          selector: { type: Type.STRING, description: 'CSS selector (e.g. "#username", ".btn-primary", "table.data")' },
          value: { type: Type.STRING, description: 'Text to type into field (for fill action)' },
          extract: {
            type: Type.STRING,
            description: 'What to extract from element',
            enum: ['text', 'html', 'href', 'src', 'all'],
          },
          clear_first: { type: Type.BOOLEAN, description: 'Clear field before typing. Default: true' },
          wait_for_navigation: { type: Type.BOOLEAN, description: 'Wait for page load after click. Default: false' },
          output_path: { type: Type.STRING, description: 'Screenshot save path' },
          full_page: { type: Type.BOOLEAN, description: 'Capture full page screenshot. Default: false' },
          timeout_ms: { type: Type.NUMBER, description: 'Wait timeout in ms. Default: 10000' },
          script: { type: Type.STRING, description: 'JavaScript to execute on page (run_script action)' },
          browser: {
            type: Type.STRING,
            description: 'Browser engine. Default: chromium',
            enum: ['chromium', 'firefox', 'webkit'],
          },
        },
        required: ['action'],
      },
    );
  }

  validateToolParams(p: WebAutomationToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, WebAutomationTool.Name);
    if (e) return e;
    const a = p.action;
    if (a === 'navigate' && !p.url) return 'web_automation/navigate: url required';
    if (['fill', 'click', 'wait', 'scrape', 'extract_table'].includes(a) && !p.selector)
      return 'web_automation/' + a + ': selector required';
    if (a === 'fill' && p.value === undefined) return 'web_automation/fill: value required';
    if (a === 'run_script' && !p.script) return 'web_automation/run_script: script required';
    if (a === 'scrape' && !p.extract) return 'web_automation/scrape: extract required (text/html/href/src/all)';
    return null;
  }

  toolLocations(p: WebAutomationToolParams): ToolLocation[] {
    return p.output_path ? [{ path: p.output_path }] : [];
  }

  getDescription(p: WebAutomationToolParams): string {
    return 'web: ' + p.action + (p.url ? ' ' + p.url.substring(0, 50) : '') + (p.selector ? ' ' + p.selector : '');
  }

  async shouldConfirmExecute(p: WebAutomationToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    if (this.validateToolParams(p)) return false;
    // Always confirm web automation - it touches external systems
    return {
      type: 'exec',
      title: '[WARN] Confirm: ' + this.getDescription(p),
      command: 'web_automation(' + p.action + ')',
      rootCommand: 'web_automation',
      onConfirm: async () => {},
    };
  }

  async execute(p: WebAutomationToolParams, signal: AbortSignal): Promise<ToolResult> {
    signal.throwIfAborted();
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    // 执行前依赖体检（fail-loud）：playwright 走 node 模块解析（DoctorService
    // 内部用 require.resolve，不看 PATH 二进制）。缺就一上来明说，别跑到启动浏览器
    // 才报错。
    const depErr = await this.preflightPlaywright();
    signal.throwIfAborted();
    if (depErr) {
      return { llmContent: depErr, returnDisplay: 'web_automation FAIL: Playwright 未安装' };
    }

    const logLabel = 'web_automation.' + p.action;
    console.time(logLabel);
    let scriptFile: string | undefined;

    try {
      signal.throwIfAborted();
      // Write a Node.js script that uses Playwright to perform the action
      const script = this.buildPlaywrightScript(p);
      scriptFile = path.join(os.tmpdir(), 'otto-web-' + Date.now() + '.mjs');

      signal.throwIfAborted();
      fs.writeFileSync(scriptFile, script);
      signal.throwIfAborted();

      const result = await this.processExecutor({
        command: 'node "' + scriptFile + '"',
        timeoutMs: (p.timeout_ms || 10000) + 30000,
        maxBuffer: 20 * 1024 * 1024,
        signal,
      });

      const output = result.stdout.trim();
      if (!output) {
        return {
          llmContent: 'web_automation FAIL: No output from browser action',
          returnDisplay: 'web_automation FAIL: No output',
        };
      }

      // Try to parse as JSON result
      try {
        const parsed = JSON.parse(output);
        if (parsed.error) {
          return {
            llmContent: 'web_automation FAIL: ' + parsed.error,
            returnDisplay: 'web_automation FAIL: ' + parsed.error,
          };
        }
        const summary = parsed.summary || 'completed';
        const data = parsed.data ? '\n\n' + JSON.stringify(parsed.data, null, 2).substring(0, 2000) : '';
        return {
          llmContent: 'web_automation OK: ' + summary + data,
          returnDisplay: 'web_automation OK: ' + summary,
        };
      } catch {
        // Not JSON, return raw
        return {
          llmContent: 'web_automation OK: ' + output.substring(0, 2000),
          returnDisplay: 'web_automation OK: ' + output.substring(0, 100),
        };
      }
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return {
        llmContent: 'web_automation FAIL: ' + m,
        returnDisplay: 'web_automation FAIL: ' + m,
      };
    } finally {
      if (scriptFile) {
        try { fs.unlinkSync(scriptFile); } catch {}
      }
      console.timeEnd(logLabel);
    }
  }

  /**
   * playwright 就绪体检（fail-loud）。DoctorService 的 playwright 探测走
   * require.resolve('playwright' / 'playwright-core')，正确反映「二进制在但 node
   * 模块没装」的情况。缺则返回带安装命令的错误串；就绪返回 null。
   */
  private async preflightPlaywright(): Promise<string | null> {
    let present = false;
    let installHint = 'npm install playwright && npx playwright install chromium';
    try {
      const report = await this.doctor.check();
      const pw = report.checks.find((c) => c.name === 'playwright');
      if (pw) {
        present = pw.present;
        if (pw.installHint) installHint = pw.installHint;
      }
    } catch {
      // 体检异常时保守判为缺失，给出通用安装命令（fail-loud）。
      present = false;
    }
    if (present) return null;
    return (
      'web_automation FAIL: Playwright 未安装（node 模块缺失）。\n' +
      `安装：${installHint}`
    );
  }

  private buildPlaywrightScript(p: WebAutomationToolParams): string {
    const timeout = p.timeout_ms || 10000;
    const stateFile = path.join(os.tmpdir(), 'otto-web-state.json');

    const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

    let body = '';

    switch (p.action) {
      case 'navigate':
        body = `
  await page.goto('${escape(p.url!)}', { waitUntil: 'networkidle', timeout: ${timeout} });
  result = { summary: 'Navigated to ${escape(p.url!.substring(0, 80))}', data: { url: page.url(), title: await page.title() } };`;
        break;

      case 'fill':
        body = `
  const el = await page.waitForSelector('${escape(p.selector!)}', { timeout: ${timeout} });
  ${p.clear_first !== false ? 'await el.fill("");' : ''}
  await el.fill('${escape(p.value!)}');
  result = { summary: 'Filled "${escape(p.selector!)}" with value', data: { selector: '${escape(p.selector!)}' } };`;
        break;

      case 'click':
        body = `
  const el = await page.waitForSelector('${escape(p.selector!)}', { timeout: ${timeout} });
  ${p.wait_for_navigation ? 'await Promise.all([page.waitForNavigation({ timeout: ' + timeout + ' }), el.click()]);' : 'await el.click();'}
  result = { summary: 'Clicked "${escape(p.selector!)}"', data: { url: page.url() } };`;
        break;

      case 'scrape':
        if (p.extract === 'all') {
          body = `
  const el = await page.waitForSelector('${escape(p.selector!)}', { timeout: ${timeout} });
  const text = await el.textContent();
  const html = await el.innerHTML();
  const href = await el.getAttribute('href');
  const src = await el.getAttribute('src');
  result = { summary: 'Scraped all from "${escape(p.selector!)}"', data: { text: text?.trim(), html: html?.substring(0, 5000), href, src } };`;
        } else {
          const extractExpr = {
            text: 'await el.textContent()',
            html: 'await el.innerHTML()',
            href: 'await el.getAttribute("href")',
            src: 'await el.getAttribute("src")',
          }[p.extract!] || 'await el.textContent()';

          body = `
  const el = await page.waitForSelector('${escape(p.selector!)}', { timeout: ${timeout} });
  const data = ${extractExpr};
  result = { summary: 'Scraped ${p.extract} from "${escape(p.selector!)}"', data: { ${p.extract}: data } };`;
        }
        break;

      case 'extract_table':
        body = `
  const tableData = await page.evaluate((sel) => {
    const table = document.querySelector(sel);
    if (!table) return null;
    const rows = Array.from(table.querySelectorAll('tr'));
    return rows.map(row => Array.from(row.querySelectorAll('td,th')).map(cell => cell.textContent?.trim() || ''));
  }, '${escape(p.selector!)}');
  result = { summary: 'Extracted table from "${escape(p.selector!)}"', data: tableData };`;
        break;

      case 'screenshot':
        body = `
  const outPath = '${escape(p.output_path || path.join(os.homedir(), 'Desktop', 'web_screenshot_' + Date.now() + '.png'))}';
  await page.screenshot({ path: outPath, fullPage: ${p.full_page || false} });
  result = { summary: 'Screenshot saved to ' + outPath, data: { path: outPath } };`;
        break;

      case 'run_script':
        body = `
  const data = await page.evaluate(() => {
    ${escape(p.script!)}
  });
  result = { summary: 'Script executed', data };`;
        break;

      case 'wait':
        body = `
  await page.waitForSelector('${escape(p.selector!)}', { timeout: ${timeout} });
  result = { summary: 'Element "${escape(p.selector!)}" appeared' };`;
        break;

      case 'list_tabs':
        body = `
  const pages = await browser.contexts()[0].pages();
  const tabs = await Promise.all(pages.map(async (p, i) => ({ index: i, url: p.url(), title: await p.title() })));
  result = { summary: tabs.length + ' tabs open', data: tabs };`;
        break;

      default:
        body = `result = { error: 'Unknown action: ${escape(p.action)}' };`;
    }

    return `import { chromium } from 'playwright';

const STATE_FILE = '${escape(stateFile).replace(/\\\\/g, '/')}';

async function main() {
  const browser = await chromium.launch({ headless: true });
  let context;
  let page;

  // Try to restore session state
  try {
    const fs = await import('fs');
    if (fs.existsSync(STATE_FILE)) {
      context = await browser.newContext({ storageState: STATE_FILE });
    } else {
      context = await browser.newContext();
    }
  } catch {
    context = await browser.newContext();
  }

  const pages = context.pages();
  page = pages.length > 0 ? pages[0] : await context.newPage();

  let result;
  try {
    ${body}
    // Save session state for next action
    try { await context.storageState({ path: STATE_FILE }); } catch {}
  } catch (err) {
    result = { error: err.message };
  }

  await browser.close();
  console.log(JSON.stringify(result));
}

main().catch(err => { console.log(JSON.stringify({ error: err.message })); process.exit(1); });`;
  }
}
