/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { CommandKind, MessageActionReturn, SlashCommand } from './types.js';
import { AuthServer } from 'otto-core';
import { exec } from 'child_process';
import { t } from '../utils/i18n.js';

// 全局认证服务器实例
let authServerInstance: AuthServer | null = null;

/**
 * 重置认证服务器实例（仅用于测试）
 */
export function _resetAuthServer(): void {
  authServerInstance = null;
}

/**
 * 启动认证服务器
 */
async function startAuthServer(): Promise<void> {
  if (authServerInstance) {
    console.log('🔄 登录服务器已在运行中');
    return;
  }

  authServerInstance = new AuthServer();
  await authServerInstance.start();
}

/**
 * 打开浏览器
 */
function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';

  exec(`${command} ${url}`, (error) => {
    if (error) {
      console.error('❌ 打开浏览器失败:', error);
    } else {
      console.log('✅ 浏览器已打开:', url);
    }
  });
}

export const loginCommand: SlashCommand = {
  name: 'login',
  description: t('command.login.description'),
  kind: CommandKind.BUILT_IN,
  action: async (_context, _args): Promise<MessageActionReturn> => {
    try {
      console.log('🚀 启动登录服务器...');

      // 启动认证服务器
      await startAuthServer();

      // 打开浏览器到认证选择页面
      openBrowser('http://localhost:7862');

      return {
        type: 'message',
        messageType: 'info',
        content: '✅ 登录服务器已启动！\n🌐 登录选择页面: http://localhost:7862\n🔗 请在浏览器中选择认证方式完成登录。',
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '未知错误';
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 登录服务器启动失败: ${errorMsg}`,
      };
    }
  },
};
