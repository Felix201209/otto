/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { thinkingCommand } from './thinkingCommand.js';
import { CommandContext, SlashCommand } from './types.js';
import { SettingScope } from '../../config/settings.js';

// Mock i18n: keep keys as raw strings so assertions stay readable.
vi.mock('../utils/i18n.js', () => ({
  t: (key: string) => key,
  tp: (key: string, args: Record<string, unknown>) => `${key}:${JSON.stringify(args)}`,
}));

// Mock otto-core extractProvider (only piece used by showStatus).
vi.mock('otto-core', () => ({
  extractProvider: () => 'openai',
}));

interface MockServices {
  settings: { setValue: ReturnType<typeof vi.fn> };
  config: {
    getThinkingConfig: ReturnType<typeof vi.fn>;
    setThinkingConfig: ReturnType<typeof vi.fn>;
    getModel: ReturnType<typeof vi.fn>;
  };
}

type ThinkingState = {
  mode: string;
  effort: string;
};

const buildContext = (currentThinking: ThinkingState): { context: CommandContext; services: MockServices } => {
  const services: MockServices = {
    settings: { setValue: vi.fn() },
    config: {
      getThinkingConfig: vi.fn().mockReturnValue(currentThinking),
      setThinkingConfig: vi.fn(),
      getModel: vi.fn().mockReturnValue('gpt-5'),
    },
  };
  const context = { services } as unknown as CommandContext;
  return { context, services };
};

const findSub = (name: string): SlashCommand => {
  const sub = thinkingCommand.subCommands?.find((s) => s.name === name);
  if (!sub) throw new Error(`subcommand '${name}' not found`);
  return sub;
};

describe('thinkingCommand', () => {
  describe('effort subcommands always force mode=on', () => {
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

    for (const effort of efforts) {
      it(`/thinking ${effort} writes {mode:'on', effort:'${effort}'} even when current mode is 'auto'`, async () => {
        const { context, services } = buildContext({ mode: 'auto', effort: 'auto' });
        const sub = findSub(effort);
        await sub.action!(context, '');

        // Persisted to user settings
        expect(services.settings.setValue).toHaveBeenCalledWith(
          SettingScope.User,
          'thinking',
          expect.objectContaining({ mode: 'on', effort }),
        );
        // And applied to runtime config
        expect(services.config.setThinkingConfig).toHaveBeenCalledWith(
          expect.objectContaining({ mode: 'on', effort }),
        );
      });

      it(`/thinking ${effort} keeps mode=on when already on`, async () => {
        const { context, services } = buildContext({ mode: 'on', effort: 'low' });
        const sub = findSub(effort);
        await sub.action!(context, '');

        expect(services.settings.setValue).toHaveBeenCalledWith(
          SettingScope.User,
          'thinking',
          expect.objectContaining({ mode: 'on', effort }),
        );
      });

      it(`/thinking ${effort} flips mode from off→on (selecting effort = wanting thinking)`, async () => {
        const { context, services } = buildContext({ mode: 'off', effort: 'auto' });
        const sub = findSub(effort);
        await sub.action!(context, '');

        expect(services.settings.setValue).toHaveBeenCalledWith(
          SettingScope.User,
          'thinking',
          expect.objectContaining({ mode: 'on', effort }),
        );
      });
    }
  });

  describe('/thinking auto', () => {
    it('clears effort to "auto" so state is fully neutral', async () => {
      // Was {mode:'on', effort:'high'} — switching to auto should not silently
      // keep effort='high' (which would produce {mode:'auto', effort:'high'},
      // a confusing combination).
      const { context, services } = buildContext({ mode: 'on', effort: 'high' });
      const sub = findSub('auto');
      await sub.action!(context, '');

      expect(services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'thinking',
        expect.objectContaining({ mode: 'auto', effort: 'auto' }),
      );
    });
  });

  describe('/thinking off', () => {
    it('sets mode=off but preserves effort (so re-enabling restores intent)', async () => {
      const { context, services } = buildContext({ mode: 'on', effort: 'max' });
      const sub = findSub('off');
      await sub.action!(context, '');

      // off → effort kept (will be replayed if user re-enables with /thinking on)
      expect(services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'thinking',
        expect.objectContaining({ mode: 'off', effort: 'max' }),
      );
    });
  });

  describe('hidden /thinking on', () => {
    it('sets mode=on with effort=high as default', async () => {
      const { context, services } = buildContext({ mode: 'auto', effort: 'auto' });
      const sub = findSub('on');
      await sub.action!(context, '');

      expect(services.settings.setValue).toHaveBeenCalledWith(
        SettingScope.User,
        'thinking',
        expect.objectContaining({ mode: 'on', effort: 'high' }),
      );
    });
  });
});
