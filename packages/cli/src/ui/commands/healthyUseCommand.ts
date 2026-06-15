/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, CommandContext, MessageActionReturn, SlashCommand } from './types.js';
import { t, tp } from '../utils/i18n.js';
import { SettingScope } from '../../config/settings.js';

export const healthyUseCommand: SlashCommand = {
  name: 'healthy-use',
  description: t('command.healthyUse.description'),
  kind: CommandKind.BUILT_IN,
  hidden: true,
  action: (context: CommandContext, args: string): MessageActionReturn => {
    const { config, settings } = context.services;
    const trimmedArgs = args.trim().toLowerCase();

    if (!config || !settings) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('error.config.not.loaded'),
      };
    }

    const isEnabled = config.getHealthyUseEnabled();

    if (!trimmedArgs) {
      const statusText = isEnabled ? t('skill.label.enabled') : t('skill.label.disabled');
      return {
        type: 'message',
        messageType: 'info',
        content: tp('command.healthyUse.status', { status: statusText }) + '\n\n' +
                t('command.healthyUse.usage.title') + '\n' +
                t('command.healthyUse.usage.on') + '\n' +
                t('command.healthyUse.usage.off'),
      };
    }

    if (trimmedArgs === 'on' || trimmedArgs === 'enable' || trimmedArgs === '1') {
      if (isEnabled) {
        return {
          type: 'message',
          messageType: 'info',
          content: '✅ ' + t('command.healthyUse.on'),
        };
      }

      settings.setValue(SettingScope.User, 'healthyUse', true);
      // 同时更新当前运行中的config对象
      (config as any).healthyUse = true;

      return {
        type: 'message',
        messageType: 'info',
        content: '🚀 ' + t('command.healthyUse.on'),
      };
    }

    if (trimmedArgs === 'off' || trimmedArgs === 'disable' || trimmedArgs === '0') {
      if (!isEnabled) {
        return {
          type: 'message',
          messageType: 'info',
          content: '✅ ' + t('command.healthyUse.off'),
        };
      }

      settings.setValue(SettingScope.User, 'healthyUse', false);
      // 同时更新当前运行中的config对象
      (config as any).healthyUse = false;

      return {
        type: 'message',
        messageType: 'info',
        content: '🛡️ ' + t('command.healthyUse.off'),
      };
    }

    return {
      type: 'message',
      messageType: 'error',
      content: tp('command.healthyUse.error.invalid_args', { args }) + '\n\n' +
              t('command.healthyUse.usage.title') + '\n' +
              t('command.healthyUse.usage.status') + '\n' +
              t('command.healthyUse.usage.on') + '\n' +
              t('command.healthyUse.usage.off'),
    };
  },
  completion: async (_context, partialArg): Promise<string[]> => {
    const lowerPartial = partialArg.toLowerCase();
    const commands = ['on', 'off', 'enable', 'disable'];
    return commands.filter(cmd => cmd.toLowerCase().includes(lowerPartial));
  },
};
