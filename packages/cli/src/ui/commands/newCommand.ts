/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Quick alias command for /session new - allows users to create a new session with /new
 * This is a hidden shortcut command that directly triggers the new session functionality
 */

import { CommandContext, SlashCommand, SwitchSessionActionReturn, CommandKind } from './types.js';
import { SessionManager } from 'otto-core';
import { t } from '../utils/i18n.js';

/**
 * Hidden quick alias command: /new
 * Directly creates a new session without going through the /session menu
 * This command is hidden from the help menu but fully functional
 */
export const newCommand: SlashCommand = {
  name: 'new',
  description: t('command.session.create.description'),
  kind: CommandKind.BUILT_IN,
  hidden: true, // Hidden from menu, only accessible via direct input
  action: async (context): Promise<SwitchSessionActionReturn> => {
    const { config } = context.services;

    try {
      const sessionManager = new SessionManager(config?.getProjectRoot() || process.cwd());

      // Create new session with current working directory
      const newSession = await sessionManager.createNewSession(undefined, process.cwd());

      // Create success message to include in history
      const successMessage = {
        type: 'info' as const,
        text: `✅ ${t('session.new.success')}\n\n📝 Session ID: \u001b[36m${newSession.sessionId}\u001b[0m\n📅 ${t('session.new.createdAt')}: ${new Date(newSession.metadata.createdAt).toLocaleString()}\n\n💡 ${t('session.new.canStartChat')}`,
      };

      // Return session switch result with success message in history
      return {
        type: 'switch_session',
        sessionId: newSession.sessionId,
        history: [successMessage],
        clientHistory: [],
      };
    } catch (error) {
      // Display error message
      context.ui.addItem({
        type: 'error',
        text: `❌ 创建新会话失败: ${error instanceof Error ? error.message : '未知错误'}`,
      }, Date.now());

      // Throw error to prevent further processing
      throw error;
    }
  },
};
