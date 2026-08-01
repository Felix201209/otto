/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { RunScopedWebDriver, type RpaWebSession } from './web-driver.js';
import type { RpaDriver } from './ports.js';

function input(action: Parameters<RpaDriver['execute']>[0]['step']['action'], args: Record<string, unknown>): Parameters<RpaDriver['execute']>[0] {
  return {
    run: { id: 'rpa-run-1' } as Parameters<RpaDriver['execute']>[0]['run'],
    step: { action, args } as Parameters<RpaDriver['execute']>[0]['step'],
    idempotencyKey: 'rpa-run-1:step:1',
  };
}

describe('RunScopedWebDriver', () => {
  it('reuses one browser session for every action in a run and records screenshots as artifacts', async () => {
    const session: RpaWebSession = {
      page: {
        goto: vi.fn(), fill: vi.fn(), click: vi.fn(), textContent: vi.fn(),
        screenshot: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])), waitForSelector: vi.fn(),
      },
      close: vi.fn(),
    };
    const factory = { create: vi.fn().mockResolvedValue(session) };
    const driver = new RunScopedWebDriver(factory);

    await driver.execute(input('web.navigate', { url: 'https://example.com' }));
    const screenshot = await driver.execute(input('web.screenshot', {}));

    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(screenshot.artifacts?.[0]).toMatchObject({ mediaType: 'image/png', redactedSummary: 'RPA page screenshot' });
    await driver.closeRun('rpa-run-1');
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it('rejects credential-bearing navigation URLs before reaching the browser', async () => {
    const factory = { create: vi.fn() };
    const driver = new RunScopedWebDriver(factory);

    await expect(driver.execute(input('web.navigate', { url: 'https://user:secret@example.com' }))).rejects.toThrow('credential-free');
    expect(factory.create).not.toHaveBeenCalled();
  });
});
