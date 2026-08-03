/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { RpaWebPage, RpaWebSession, RpaWebSessionFactory } from './web-driver.js';

interface PlaywrightContext {
  newPage(): Promise<RpaWebPage>;
  close(): Promise<void>;
}

interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium?: {
    launch(options: { headless: boolean; executablePath?: string }): Promise<PlaywrightBrowser>;
  };
}

export interface PlaywrightSessionOptions {
  /** Explicit browser path for an isolated deployment or controlled E2E run. */
  executablePath?: string;
}

/** Runtime Playwright adapter. It is intentionally optional so Core does not bundle a browser. */
export class PlaywrightWebSessionFactory implements RpaWebSessionFactory {
  constructor(private readonly options: PlaywrightSessionOptions = {}) {}

  async create(): Promise<RpaWebSession> {
    let module: PlaywrightModule;
    try {
      module = (await import('playwright')) as unknown as PlaywrightModule;
    } catch {
      throw new Error('RPA Web Driver requires the optional "playwright" package.');
    }
    if (!module.chromium) {
      throw new Error('RPA Web Driver requires the optional "playwright" package.');
    }
    const browser = await module.chromium.launch({ headless: true, executablePath: this.options.executablePath });
    const context = await browser.newContext();
    const page = await context.newPage();
    return {
      page,
      async close(): Promise<void> {
        await context.close();
        await browser.close();
      },
    };
  }
}
