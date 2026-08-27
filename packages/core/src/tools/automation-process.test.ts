/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { executeAutomationProcess } from './automation-process.js';

function nodeCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

describe('automation process cancellation', () => {
  it('does not spawn work when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      executeAutomationProcess({
        command: nodeCommand('process.stdout.write("should-not-run")'),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('terminates a running automation process when aborted', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const running = executeAutomationProcess({
      command: nodeCommand('setTimeout(() => {}, 10_000)'),
      signal: controller.signal,
      timeoutMs: 15_000,
      killGraceMs: 100,
    });

    setTimeout(() => controller.abort(), 50);

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('returns stdout for a successful automation process', async () => {
    await expect(
      executeAutomationProcess({ command: nodeCommand('process.stdout.write("ok")') }),
    ).resolves.toMatchObject({ stdout: 'ok' });
  });
});
