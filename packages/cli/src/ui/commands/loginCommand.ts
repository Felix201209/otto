/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { CommandKind, MessageActionReturn, SlashCommand } from './types.js';
import { isChineseLocale, t } from '../utils/i18n.js';

/**
 * 兼容性占位：旧版 /login 会启动 otto 浏览器登录服务器。
 * Otto 是 BYO-key（自带 key）产品，已删除该登录流程。
 * 保留此空实现仅为不破坏依赖该导出的调用方（如测试）。
 */
export function _resetAuthServer(): void {
  // no-op：已无认证服务器实例需要重置。
}

export const loginCommand: SlashCommand = {
  name: 'login',
  description: t('command.login.description'),
  kind: CommandKind.BUILT_IN,
  // Otto 自带 key、无需登录。/login 不再启动已废弃的 otto 浏览器登录，
  // 直接提示用户用 /model 或 otto setup 配置模型。
  action: async (_context, _args): Promise<MessageActionReturn> => ({
    type: 'message',
    messageType: 'info',
    content: isChineseLocale()
      ? 'Otto 自带 key，无需登录。\n运行 `/model` 管理模型，或运行 `otto setup` 配置 API key 和模型。'
      : 'Otto ships with built-in key handling — no login required.\nRun `/model` to manage models, or `otto setup` to configure your API key and model.',
  }),
};
