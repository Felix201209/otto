/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */


import { CommandKind, CommandContext, SlashCommand, SlashCommandActionReturn } from './types.js';
import { t, tp } from '../utils/i18n.js';
import { getCoreSystemPrompt, ApprovalMode } from 'otto-core';
import type { AgentStyle } from 'otto-core';

/**
 * Otto 工作方式切换命令。
 *
 * 功能：
 * - /agent-style: 显示当前风格及帮助
 * - /agent-style chat: 日常对话
 * - /agent-style fast: 快速执行
 * - /agent-style code: 工作代码
 * - /agent-style engineering: 工程交付
 * - /agent-style direct: 简洁开发
 * - /agent-style office: 企业办公
 * - /agent-style collab: 协作推进
 * - /agent-style status: 查看当前风格状态
 *
 * 切换后会：
 * 1. 持久化到 projectSettings.json（重启后保持）
 * 2. 即时刷新 system prompt（当前会话立即生效）
 */
export const agentStyleCommand: SlashCommand = {
  name: 'agent-style',
  description: t('command.agentStyle.description'),
  kind: CommandKind.BUILT_IN,
  hidden: true,
  action: async (context: CommandContext, args: string): Promise<SlashCommandActionReturn> => {
    const { config } = context.services;
    const trimmedArgs = args.trim().toLowerCase();

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('agentStyle.error.config.unavailable'),
      };
    }

    const currentStyle = config.getAgentStyle();

    const getStyleInfo = (style: AgentStyle) => {
      switch (style) {
        case 'codex': return { icon: '⚡', label: t('agentStyle.style.codex.label'), desc: t('agentStyle.style.codex.description') };
        case 'cursor': return { icon: '↗️', label: t('agentStyle.style.cursor.label'), desc: t('agentStyle.style.cursor.description') };
        case 'augment': return { icon: '🚀', label: t('agentStyle.style.augment.label'), desc: t('agentStyle.style.augment.description') };
        case 'claude-code': return { icon: '✳️', label: t('agentStyle.style.claudeCode.label'), desc: t('agentStyle.style.claudeCode.description') };
        case 'antigravity': return { icon: '🌈', label: t('agentStyle.style.antigravity.label'), desc: t('agentStyle.style.antigravity.description') };
        case 'windsurf': return { icon: '🌊', label: t('agentStyle.style.windsurf.label'), desc: t('agentStyle.style.windsurf.description') };
        default: return { icon: '𝓥', label: t('agentStyle.style.default.label'), desc: t('agentStyle.style.default.description') };
      }
    };

    // 无参数或 status: 显示当前状态和帮助
    if (!trimmedArgs || trimmedArgs === 'status') {
      const { icon, label, desc } = getStyleInfo(currentStyle);

      return {
        type: 'message',
        messageType: 'info',
        content: `${icon} ${tp('agentStyle.status.current', { style: label })}

` +
          `${desc}

` +
          `${t('agentStyle.usage.title')}
` +
          `  /agent-style chat         - ${t('agentStyle.usage.default')}
` +
          `  /agent-style fast         - ${t('agentStyle.usage.codex')}
` +
          `  /agent-style code         - ${t('agentStyle.usage.cursor')}
` +
          `  /agent-style engineering  - ${t('agentStyle.usage.augment')}
` +
          `  /agent-style direct       - ${t('agentStyle.usage.claudeCode')}
` +
          `  /agent-style office       - ${t('agentStyle.usage.antigravity')}
` +
          `  /agent-style collab       - ${t('agentStyle.usage.windsurf')}
` +
          `  /agent-style status       - ${t('agentStyle.usage.status')}`,
      };
    }

    /**
     * 切换 Agent 风格并刷新 system prompt
     * Codex 模式自动启用 YOLO，其他模式恢复普通确认
     */
    const switchStyle = async (newStyle: AgentStyle): Promise<SlashCommandActionReturn> => {
      try {
        // 1. 持久化 agent style
        config.setAgentStyle(newStyle);

        // 2. Codex 模式自动启用 YOLO
        if (newStyle === 'codex') {
          config.setApprovalModeWithProjectSync(ApprovalMode.YOLO, true);
        } else {
          // 切回其他模式时恢复普通确认模式
          config.setApprovalModeWithProjectSync(ApprovalMode.DEFAULT, true);
        }

        // 3. 刷新当前会话的 system prompt
        const geminiClient = await config.getOttoClient();
        if (geminiClient) {
          const chat = geminiClient.getChat();
          if (chat) {
            const isVSCode = config.getVsCodePluginMode();
            const userMemory = config.getUserMemory();
            const updatedSystemPrompt = getCoreSystemPrompt(
              userMemory,
              isVSCode,
              undefined,
              newStyle,
              undefined,
              config.getPreferredLanguage()
            );
            chat.setSystemInstruction(updatedSystemPrompt);
          }
        }

        const { icon, label } = getStyleInfo(newStyle);
        const yoloNote = newStyle === 'codex'
          ? `\n${t('agentStyle.codex.yolo.enabled')}`
          : '';

        return {
          type: 'message',
          messageType: 'info',
          content: `${icon} ${tp('agentStyle.switched.success', { style: label })}${yoloNote}`,
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: `❌ ${t('agentStyle.error.switch.failed')}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };

    // 映射子命令到 AgentStyle
    const styleMap: Record<string, AgentStyle> = {
      'chat': 'default',
      'default': 'default',
      'claude': 'default',
      'codex': 'codex',
      'fast': 'codex',
      'code': 'cursor',
      'cursor': 'cursor',
      'engineering': 'augment',
      'augment': 'augment',
      'direct': 'claude-code',
      'claude-code': 'claude-code',
      'office': 'antigravity',
      'antigravity': 'antigravity',
      'collab': 'windsurf',
      'windsurf': 'windsurf',
      'wave': 'windsurf',
    };

    if (styleMap[trimmedArgs]) {
      const newStyle = styleMap[trimmedArgs];
      if (currentStyle === newStyle) {
        const { icon } = getStyleInfo(newStyle);
        return {
          type: 'message',
          messageType: 'info',
          content: `${icon} ${tp('agentStyle.already.using', { style: trimmedArgs })}`,
        };
      }
      return switchStyle(newStyle);
    }

    // 未知参数
    return {
      type: 'message',
      messageType: 'error',
      content: t('agentStyle.usage.error'),
    };
  },

  completion: async (_context, partialArg) => {
    const commands = ['chat', 'fast', 'code', 'engineering', 'direct', 'office', 'collab', 'status'];
    return commands.filter((cmd) => cmd.startsWith(partialArg.toLowerCase()));
  },
};
