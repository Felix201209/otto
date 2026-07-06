/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * WebAutomationTool 单测。重点：doctor 前置对 playwright 的 fail-loud —— playwright
 * 走 node 模块解析（不是 PATH 二进制），node_modules 里没装时应提前明说未安装 +
 * 给安装命令，而不是跑到启动浏览器才报错。
 *
 * 通过给工具注入「装了 fake runner/resolver 的真实 DoctorService」来模拟环境，
 * 不 mock 全局模块，也不真的启动浏览器。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WebAutomationTool } from './web-automation.js';
import { createMockConfig } from '../utils/test-helpers.js';
import {
  DoctorService,
  type CommandRunner,
  type ModuleResolver,
} from '../services/doctor.js';

/** which/where 全部命中（模拟本机全局装了 playwright 的二进制）。 */
const RUNNER_BIN_PRESENT: CommandRunner = async (command: string) => {
  const m = command.match(/^(?:which|where)\s+(\S+)/);
  if (m) return `/usr/local/bin/${m[1]}`;
  // 任意 --version：回一个带版本号的串。
  return 'x version 1.0.0';
};

/** node 模块解析：playwright 不可解析（node_modules 里没装）。 */
const RESOLVER_NO_PLAYWRIGHT: ModuleResolver = (name: string) => {
  throw new Error(`Cannot find module '${name}'`);
};

/** node 模块解析：playwright 可解析（node_modules 里装了）。 */
const RESOLVER_HAS_PLAYWRIGHT: ModuleResolver = (name: string) => {
  if (name === 'playwright' || name === 'playwright-core') {
    return `/proj/node_modules/${name}/index.js`;
  }
  throw new Error(`Cannot find module '${name}'`);
};

function toolWith(resolver: ModuleResolver): WebAutomationTool {
  // 平台固定 darwin，pathExists 恒 false（.app 兜底对 playwright 无关）。
  const doctor = new DoctorService(RUNNER_BIN_PRESENT, resolver, 'darwin', () => false);
  return new WebAutomationTool(createMockConfig(), doctor);
}

describe('WebAutomationTool', () => {
  let tool: WebAutomationTool;

  beforeEach(() => {
    tool = new WebAutomationTool(createMockConfig());
  });

  // --- Metadata ---
  it('has correct name', () => {
    expect(WebAutomationTool.Name).toBe('web_automation');
  });
  it('has display name', () => {
    expect(tool.displayName).toBe('WebAutomation');
  });

  // --- Validation ---
  it('rejects navigate without url', () => {
    expect(tool.validateToolParams({ action: 'navigate' })).toContain('url');
  });
  it('rejects click without selector', () => {
    expect(tool.validateToolParams({ action: 'click' })).toContain('selector');
  });
  it('rejects fill without value', () => {
    expect(tool.validateToolParams({ action: 'fill', selector: '#x' })).toContain('value');
  });
  it('accepts navigate with url', () => {
    expect(tool.validateToolParams({ action: 'navigate', url: 'https://a.com' })).toBeNull();
  });

  // --- doctor 前置：playwright 缺失 fail-loud（重点） ---
  it('fails loudly when playwright node module is missing, even if binary is on PATH', async () => {
    // which playwright 命中（模拟全局二进制在），但 node 模块解析失败。
    const t = toolWith(RESOLVER_NO_PLAYWRIGHT);
    const r = await t.execute(
      { action: 'navigate', url: 'https://example.com' },
      new AbortController().signal,
    );
    const content = String(r.llmContent);
    expect(content).toContain('web_automation FAIL');
    expect(content).toContain('Playwright');
    // 必须带安装命令（DoctorService 的 installHint）。
    expect(content).toContain('npm i playwright');
    expect(content).toContain('playwright install');
  });

  it('missing-playwright failure returns before touching the browser', async () => {
    const t = toolWith(RESOLVER_NO_PLAYWRIGHT);
    const r = await t.execute(
      { action: 'screenshot', output_path: '/tmp/should-not-exist.png' },
      new AbortController().signal,
    );
    // 提前返回，不进 ProcessGuard —— returnDisplay 是明确的缺失提示。
    expect(String(r.returnDisplay)).toContain('Playwright');
    expect(String(r.returnDisplay)).toContain('未安装');
  });

  // --- doctor 前置：validate 失败时不误报 playwright 缺失 ---
  it('validation error takes precedence over playwright preflight', async () => {
    const t = toolWith(RESOLVER_NO_PLAYWRIGHT);
    const r = await t.execute({ action: 'navigate' }, new AbortController().signal);
    // 缺 url 的 validation 错误应先返回，而非 playwright 提示。
    expect(String(r.llmContent)).toContain('url required');
    expect(String(r.llmContent)).not.toContain('Playwright');
  });

  // --- doctor 前置：playwright 就绪时体检放行（白盒，不启动浏览器） ---
  it('doctor reports playwright present when node module resolves', async () => {
    const doctor = new DoctorService(
      RUNNER_BIN_PRESENT,
      RESOLVER_HAS_PLAYWRIGHT,
      'darwin',
      () => false,
    );
    const report = await doctor.check();
    const pw = report.checks.find((c) => c.name === 'playwright')!;
    expect(pw.present).toBe(true);
    expect(pw.installHint).toBeUndefined();
  });
});
