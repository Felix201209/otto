/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from 'otto-core';
import type { LoadedSettings } from '../config/settings.js';
import { CommandHandler } from './acpCommandHandler.js';

function makeContext(): {
  config: Config;
  settings: LoadedSettings;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const config = {
    getUserMemory: () => '',
    getOttoMdFileCount: () => 0,
    getOttoMdFilePaths: () => [],
    getTargetDir: () => process.cwd(),
    getModel: () => 'auto',
  } as unknown as Config;
  const settings = {
    merged: { selectedAuthType: 'proxy-auth' },
  } as unknown as LoadedSettings;
  const sendMessage = vi.fn<[string], Promise<void>>(async () => undefined);
  return { config, settings, sendMessage };
}

describe('CommandHandler', () => {
  it('lists the default built-in commands', () => {
    const handler = new CommandHandler();
    const names = handler.getAvailableCommands().map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'help',
        'about',
        'memory',
        'memory show',
        'memory list',
        'init',
        'extensions',
      ]),
    );
    // `/restore` is intentionally not advertised to ACP clients while the
    // checkpoint flow is still a core-side stub. The user-facing rewind
    // gesture goes through the `_otto/session/rewind` extension RPC.
    expect(names).not.toContain('restore');
  });

  it('returns false for non-slash text', async () => {
    const handler = new CommandHandler();
    const ctx = makeContext();
    const handled = await handler.handleCommand('just a question', ctx);
    expect(handled).toBe(false);
    expect(ctx.sendMessage).not.toHaveBeenCalled();
  });

  it('executes /help and emits a help banner', async () => {
    const handler = new CommandHandler();
    const ctx = makeContext();
    const handled = await handler.handleCommand('/help', ctx);
    expect(handled).toBe(true);
    expect(ctx.sendMessage).toHaveBeenCalledTimes(1);
    const msg = ctx.sendMessage.mock.calls[0][0] as string;
    expect(msg).toMatch(/Otto Help/);
    expect(msg).toMatch(/\/help/);
  });

  it('resolves multi-word commands (memory show)', async () => {
    const handler = new CommandHandler();
    const ctx = makeContext();
    const handled = await handler.handleCommand('/memory show', ctx);
    expect(handled).toBe(true);
    expect(ctx.sendMessage).toHaveBeenCalled();
    const msg = ctx.sendMessage.mock.calls[0][0] as string;
    expect(msg).toMatch(/Memory is currently empty\.|Current memory content/);
  });

  it('emits an error message for unknown subcommands (falls back to parent)', async () => {
    const handler = new CommandHandler();
    const ctx = makeContext();
    const handled = await handler.handleCommand('/memory bogus', ctx);
    // "memory" parent matches, but there's no "memory bogus" subcommand so the
    // parent executor runs with args = ["bogus"].
    expect(handled).toBe(true);
    expect(ctx.sendMessage).toHaveBeenCalled();
  });
});
