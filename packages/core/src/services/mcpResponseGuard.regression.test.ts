/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPResponseGuard } from './mcpResponseGuard.js';

const guards: MCPResponseGuard[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(guards.splice(0).map((guard) => guard.cleanup()));
});

describe('MCPResponseGuard idle load and HTML regressions', () => {
  it('does not schedule cleanup work until a temporary file exists', () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, 'setTimeout');
    guards.push(new MCPResponseGuard({ tempDir: path.join(os.tmpdir(), 'otto-unused-mcp-guard') }));
    expect(timer).not.toHaveBeenCalled();
  });

  it('preserves self-closing HTML instead of injecting source text', async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-mcp-html-'));
    const guard = new MCPResponseGuard({ tempDir, maxResponseSize: 16 });
    guards.push(guard);
    const stored = (guard as unknown as { formatHtml: (html: string) => string })
      .formatHtml('<div>before<br>after<img src="x"></div>');
    expect(stored).toContain('<br>');
    expect(stored).toContain('<img src="x">');
    expect(stored).not.toContain('private extractPlainText');
  });
});
