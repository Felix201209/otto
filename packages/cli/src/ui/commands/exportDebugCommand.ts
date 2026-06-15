/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */
import { CommandContext, SlashCommand, MessageActionReturn, CommandKind } from './types.js';
import { t, tp } from '../utils/i18n.js';
import { exportDebugToMarkdown } from '../../utils/debugExport.js';

export const exportDebugCommand: SlashCommand = {
  name: 'export-debug',
  description: t('command.export_debug.description'),
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    const { config } = context.services;
    const { debugMessages } = context.ui;
    // 🆕 默认导出全部消息（log/warn/error/debug）。
    // 历史上默认仅导出 error/warn，但实际排查 bug 时几乎都需要 console.log
    // 之类的 trace 信息。可显式传 `errors` / `errors-only` 回到旧行为。
    const argLower = (args || '').trim().toLowerCase();
    const errorsOnly = argLower === 'errors' || argLower === 'errors-only';
    const includeAll = !errorsOnly;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('export.no_config'),
      };
    }

    if (!debugMessages || debugMessages.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('export_debug.no_messages'),
      };
    }

    const sessionId = config.getSessionId();
    const projectRoot = config.getProjectRoot() || process.cwd();

    try {
      const exportPath = await exportDebugToMarkdown(debugMessages, projectRoot, sessionId, includeAll);

      return {
        type: 'message',
        messageType: 'info',
        content: tp('export.success', { path: exportPath }),
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'NO_ERRORS_OR_WARNINGS') {
        return {
          type: 'message',
          messageType: 'info',
          content: t('export_debug.no_errors'),
        };
      }
      return {
        type: 'message',
        messageType: 'error',
        content: tp('export.failed', { error: error instanceof Error ? error.message : String(error) }),
      };
    }
  },
};
