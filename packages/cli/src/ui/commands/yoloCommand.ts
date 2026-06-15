/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */


import { ApprovalMode } from 'otto-core';
import { CommandKind, CommandContext, MessageActionReturn, SlashCommand } from './types.js';
import { t } from '../utils/i18n.js';

// 功能实现: 动态切换YOLO模式的斜杠命令
// 实现方案: 通过Config.setApprovalMode()方法实现运行时模式切换
// 影响范围: packages/cli/src/ui/commands/yoloCommand.ts (新建文件)
// 实现日期: 2025-01-27

export const yoloCommand: SlashCommand = {
  name: 'yolo',
  description: t('command.yolo.description'),
  kind: CommandKind.BUILT_IN,
  hidden: true,
  action: (context: CommandContext, args: string): MessageActionReturn => {
    const { config } = context.services;
    const trimmedArgs = args.trim().toLowerCase();

    // 检查config是否可用
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: '配置未初始化，无法切换YOLO模式。',
      };
    }

    const currentMode = config.getApprovalMode();
    const isCurrentlyYolo = currentMode === ApprovalMode.YOLO;

    // 如果没有参数，显示当前状态
    if (!trimmedArgs) {
      const statusText = isCurrentlyYolo ? '已开启' : '已关闭';
      const statusIcon = isCurrentlyYolo ? '✅' : '❌';

      return {
        type: 'message',
        messageType: 'info',
        content: `${statusIcon} YOLO模式当前${statusText}\n\n` +
                `YOLO模式：${isCurrentlyYolo ? '自动批准所有工具调用' : '需要手动确认工具调用'}\n\n` +
                `使用方法：\n` +
                `  /yolo on   - 开启YOLO模式\n` +
                `  /yolo off  - 关闭YOLO模式\n` +
                `  Ctrl+Y     - 切换YOLO模式`,
      };
    }

    // 处理开启命令
    if (trimmedArgs === 'on' || trimmedArgs === 'enable' || trimmedArgs === '1') {
      if (isCurrentlyYolo) {
        return {
          type: 'message',
          messageType: 'info',
          content: '✅ YOLO模式已经是开启状态。',
        };
      }

      try {
        config.setApprovalModeWithProjectSync(ApprovalMode.YOLO, true);

        return {
          type: 'message',
          messageType: 'info',
          content: '🚀 已开启YOLO模式！\n\n' +
                  '⚠️  注意：所有工具调用将自动执行，无需确认。\n' +
                  '使用 /yolo off 可以关闭此模式。',
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: `❌ 开启YOLO模式失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // 处理关闭命令
    if (trimmedArgs === 'off' || trimmedArgs === 'disable' || trimmedArgs === '0') {
      if (!isCurrentlyYolo) {
        return {
          type: 'message',
          messageType: 'info',
          content: '❌ YOLO模式已经是关闭状态。',
        };
      }

      try {
        config.setApprovalModeWithProjectSync(ApprovalMode.DEFAULT, true);

        return {
          type: 'message',
          messageType: 'info',
          content: '🛡️ 已关闭YOLO模式。\n\n' +
                  '所有工具调用现在需要手动确认后执行。',
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: `❌ 关闭YOLO模式失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // 处理无效参数
    return {
      type: 'message',
      messageType: 'error',
      content: `❌ 无效的参数：${args}\n\n` +
              `有效用法：\n` +
              `  /yolo      - 查看当前状态\n` +
              `  /yolo on   - 开启YOLO模式\n` +
              `  /yolo off  - 关闭YOLO模式`,
    };
  },

  // 提供自动完成功能
  completion: async (_context, partialArg): Promise<string[]> => {
    const lowerPartial = partialArg.toLowerCase();
    const commands = ['on', 'off', 'enable', 'disable'];

    return commands.filter(cmd =>
      cmd.toLowerCase().includes(lowerPartial)
    );
  },
};
