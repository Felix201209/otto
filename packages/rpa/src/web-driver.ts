/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { RpaDriver } from './ports.js';

export interface RpaWebPage {
  goto(url: string, options: { waitUntil: 'networkidle'; timeout: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  screenshot(options: { fullPage: boolean }): Promise<Uint8Array>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<void>;
}

export interface RpaWebSession {
  page: RpaWebPage;
  close(): Promise<void>;
}

export interface RpaWebSessionFactory {
  create(): Promise<RpaWebSession>;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`RPA web action requires ${name}.`);
  return value;
}

function timeout(args: Record<string, unknown>): number {
  const value = args['timeoutMs'];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 60_000 ? value : 15_000;
}

function safeUrl(value: string): string {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('RPA web navigation only accepts credential-free HTTP(S) URLs.');
  }
  return parsed.toString();
}

/** Maintains one browser context per RPA run instead of starting Chromium for every action. */
export class RunScopedWebDriver implements RpaDriver {
  private readonly sessions = new Map<string, RpaWebSession>();

  constructor(private readonly factory: RpaWebSessionFactory) {}

  async execute(input: Parameters<RpaDriver['execute']>[0]): ReturnType<RpaDriver['execute']> {
    const { action, args } = input.step;
    const wait = timeout(args);
    switch (action) {
      case 'web.navigate': {
        const url = safeUrl(requiredString(args, 'url'));
        const session = await this.sessionFor(input.run.id, true);
        await session.page.goto(url, { waitUntil: 'networkidle', timeout: wait });
        return { output: { url } };
      }
      case 'web.fill': {
        const session = await this.sessionFor(input.run.id);
        await session.page.fill(requiredString(args, 'selector'), requiredString(args, 'value'));
        return { output: { filled: true } };
      }
      case 'web.click': {
        const session = await this.sessionFor(input.run.id);
        await session.page.click(requiredString(args, 'selector'));
        return { output: { clicked: true } };
      }
      case 'web.extract': {
        const session = await this.sessionFor(input.run.id);
        const text = await session.page.textContent(requiredString(args, 'selector'));
        return { output: { text: text ?? '' } };
      }
      case 'web.screenshot': {
        const session = await this.sessionFor(input.run.id);
        const bytes = await session.page.screenshot({ fullPage: args['fullPage'] === true });
        return {
          output: { captured: true },
          artifacts: [{ mediaType: 'image/png', bytes, redactedSummary: 'RPA page screenshot' }],
        };
      }
      case 'web.wait': {
        const session = await this.sessionFor(input.run.id);
        await session.page.waitForSelector(requiredString(args, 'selector'), { timeout: wait });
        return { output: { ready: true } };
      }
      case 'checkpoint':
        return { output: { checkpoint: input.idempotencyKey } };
      default:
        throw new Error(`Unsupported RPA action: ${action}`);
    }
  }

  async closeRun(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) return;
    this.sessions.delete(runId);
    await session.close();
  }

  private async sessionFor(runId: string, createForNavigation = false): Promise<RpaWebSession> {
    const existing = this.sessions.get(runId);
    if (existing) return existing;
    if (!createForNavigation) {
      throw new Error('RPA browser context is unavailable for this run. Resume from a web.navigate checkpoint; do not replay a page action in a new blank session.');
    }
    const created = await this.factory.create();
    this.sessions.set(runId, created);
    return created;
  }
}
