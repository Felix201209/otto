/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PlaywrightWebSessionFactory } from './playwright-session-factory.js';
import { RunScopedWebDriver } from './web-driver.js';
import type { RpaDriver } from './ports.js';

const browserSuite = process.env['RUN_RPA_BROWSER_E2E'] === '1' ? describe : describe.skip;

function input(action: Parameters<RpaDriver['execute']>[0]['step']['action'], args: Record<string, unknown>): Parameters<RpaDriver['execute']>[0] {
  return {
    run: { id: 'rpa-e2e-run' } as Parameters<RpaDriver['execute']>[0]['run'],
    step: { action, args } as Parameters<RpaDriver['execute']>[0]['step'],
    idempotencyKey: `rpa-e2e-run:${action}:1`,
  };
}

browserSuite('Playwright RPA browser boundary', () => {
  it('navigates, fills, clicks, extracts, and closes an isolated local page', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<input id="name"><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">save</button><div id="result"></div>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const driver = new RunScopedWebDriver(new PlaywrightWebSessionFactory({
      executablePath: process.env['OTTO_RPA_BROWSER_EXECUTABLE'],
    }));
    try {
      await driver.execute(input('web.navigate', { url: `http://127.0.0.1:${port}/` }));
      await driver.execute(input('web.fill', { selector: '#name', value: 'Otto' }));
      await driver.execute(input('web.click', { selector: '#save' }));
      const extracted = await driver.execute(input('web.extract', { selector: '#result' }));

      expect(extracted.output).toEqual({ text: 'Otto' });
    } finally {
      await driver.closeRun('rpa-e2e-run');
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
