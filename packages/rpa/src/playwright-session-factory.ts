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
    launch(options: { headless: boolean }): Promise<PlaywrightBrowser>;
  };
}

function dynamicImport(specifier: string): Promise<unknown> {
  const loader = new Function('moduleSpecifier', 'return import(moduleSpecifier);') as (
    moduleSpecifier: string,
  ) => Promise<unknown>;
  return loader(specifier);
}

/** Runtime Playwright adapter. It is intentionally optional so Core does not bundle a browser. */
export class PlaywrightWebSessionFactory implements RpaWebSessionFactory {
  async create(): Promise<RpaWebSession> {
    const module = await dynamicImport('playwright') as PlaywrightModule;
    if (!module.chromium) {
      throw new Error('RPA Web Driver requires the optional "playwright" package.');
    }
    const browser = await module.chromium.launch({ headless: true });
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
