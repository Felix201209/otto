/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, CommandContext, SlashCommand, SlashCommandActionReturn } from './types.js';
import { t, tp } from '../utils/i18n.js';
import { extractProvider, ThinkingConfig } from 'otto-core';
import { SettingScope } from '../../config/settings.js';

/**
 * 思考模式及强度调控命令
 *
 * 功能：
 * - /thinking: 显示当前状态及帮助
 * - /thinking on: 开启思考模式（隐藏：默认重定向为高深度开启）
 * - /thinking off: 关闭思考模式
 * - /thinking auto: 设为自动（由模型/提供商默认决定）
 * - /thinking low: 设置低强度思考 (effort = 'low')
 * - /thinking medium: 设置中强度思考 (effort = 'medium')
 * - /thinking high: 设置高强度思考 (effort = 'high')
 * - /thinking xhigh: 设置超高强度思考 (effort = 'xhigh')
 * - /thinking max: 设置最大强度思考 (effort = 'max')
 * - /thinking status: 查看当前配置及生效情况
 *
 * 说明：本命令同时使用 `action` 与 `subCommands`：
 *   - 子命令负责让 Tab 补全菜单自动列出可选项（off/auto/low/.../status）。
 *   - 父级 `action` 在 `/thinking`（无参数）或 `/thinking <unknown>` 时兜底，
 *     分别显示当前状态或返回用法错误。
 */

const getModeLabel = (mode: string): string => {
  switch (mode) {
    case 'on': return t('thinking.mode.on');
    case 'off': return t('thinking.mode.off');
    case 'auto':
    default: return t('thinking.mode.auto');
  }
};

const getEffortLabel = (effort: string | undefined): string => {
  switch (effort) {
    case 'low': return t('thinking.effort.low');
    case 'medium': return t('thinking.effort.medium');
    case 'high': return t('thinking.effort.high');
    case 'max': return t('thinking.effort.max');
    case 'xhigh': return t('thinking.effort.xhigh');
    case 'auto':
    default: return t('thinking.effort.auto');
  }
};

/** 显示当前思考状态及帮助 */
const showStatus = (context: CommandContext): SlashCommandActionReturn => {
  const { config } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('thinking.error.config.unavailable'),
    };
  }

  const currentModelId = config.getModel();
  const provider = extractProvider(currentModelId);
  const currentConfig: ThinkingConfig = config.getThinkingConfig() || { mode: 'auto', effort: 'auto' };

  const modeLabel = getModeLabel(currentConfig.mode);
  const effortLabel = getEffortLabel(currentConfig.effort);

  let providerNote = '';
  if (provider === 'openai') {
    providerNote = `\n⚠️  ${t('thinking.provider.openai.warning')}`;
  } else if (provider === 'anthropic') {
    providerNote = `\n✅  ${t('thinking.provider.anthropic.ok')}`;
  } else if (provider === 'openai-responses') {
    providerNote = `\n✅  ${t('thinking.provider.openaiResponses.ok')}`;
  }

  return {
    type: 'message',
    messageType: 'info',
    content: `💭 ${tp('thinking.status.current', { mode: modeLabel, effort: effortLabel })}${providerNote}

${t('thinking.usage.title')}
  /thinking off            - ${t('thinking.usage.off')}
  /thinking auto           - ${t('thinking.usage.auto')}
  /thinking low|medium|high|xhigh|max - ${t('thinking.usage.effort')}
  /thinking status         - ${t('thinking.usage.status')}`,
  };
};

/** 写入新的思考配置（运行时 + 用户全局 settings 持久化） */
const applyThinking = async (
  context: CommandContext,
  newMode: 'on' | 'off' | 'auto',
  newEffort?: ThinkingConfig['effort'],
): Promise<SlashCommandActionReturn> => {
  const { config, settings } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('thinking.error.config.unavailable'),
    };
  }

  try {
    const currentConfig: ThinkingConfig = config.getThinkingConfig() || { mode: 'auto', effort: 'auto' };
    // Effort resolution: explicit param > previous value > 'auto'.
    // 但当 mode === 'auto' 时，强制把 effort 也归位为 'auto'，避免出现
    // {mode:'auto', effort:'high'} 这种"语义模糊"的组合（参见 footerUtils 注释）。
    let effectiveEffort: ThinkingConfig['effort'];
    if (newEffort !== undefined) {
      effectiveEffort = newEffort;
    } else if (newMode === 'auto') {
      effectiveEffort = 'auto';
    } else {
      effectiveEffort = currentConfig.effort ?? 'auto';
    }

    const updated: ThinkingConfig = {
      mode: newMode,
      effort: effectiveEffort,
      ...(currentConfig.budgetTokens !== undefined ? { budgetTokens: currentConfig.budgetTokens } : {}),
    };

    // 1. 运行时会话级覆盖 (内存中立即生效)
    config.setThinkingConfig(updated);
    // 2. 持久化到用户全局 settings.json (~/.deepv/settings.json)
    settings.setValue(SettingScope.User, 'thinking', updated);

    return {
      type: 'message',
      messageType: 'info',
      content: `✨ ${tp('thinking.switched.success', {
        mode: getModeLabel(newMode),
        effort: getEffortLabel(updated.effort),
      })}`,
    };
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: `❌ ${t('thinking.error.switch.failed')}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/**
 * 强度子命令工厂：用户显式选择某个强度等价于「我想要 thinking 开启」，
 * 因此总是把 mode 设为 'on'。在网络层 mode='auto'+effort=具体值 与 mode='on'+
 * effort=具体值 行为完全一致（见 customModel.applyOpenAIChatThinking 的分发
 * 矩阵），过去保留 'auto' 只是 UI 标签的形式上的尊重，反而会让 footer 与
 * VSCode 选择器无法直观反映强度。
 */
const makeEffortSubCommand = (
  effort: Exclude<ThinkingConfig['effort'], undefined>,
  description: string,
): SlashCommand => ({
  name: effort,
  description,
  kind: CommandKind.BUILT_IN,
  action: async (context) => applyThinking(context, 'on', effort),
});

export const thinkingCommand: SlashCommand = {
  name: 'thinking',
  description: t('command.thinking.description'),
  kind: CommandKind.BUILT_IN,
  // 父级 action 仅用于兜底：无参数显示状态、未知参数返回用法错误。
  // 子命令优先匹配，因此 `/thinking off` 等会走对应子命令的 action。
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const trimmed = args.trim().toLowerCase();
    if (!trimmed) {
      return showStatus(context);
    }
    return {
      type: 'message',
      messageType: 'error',
      content: t('thinking.usage.error'),
    };
  },
  subCommands: [
    {
      name: 'off',
      description: t('thinking.usage.off'),
      kind: CommandKind.BUILT_IN,
      action: async (context) => applyThinking(context, 'off'),
    },
    {
      name: 'auto',
      description: t('thinking.usage.auto'),
      kind: CommandKind.BUILT_IN,
      // mode → auto，effort 保留原值（applyThinking 的兜底逻辑会处理）
      action: async (context) => applyThinking(context, 'auto'),
    },
    makeEffortSubCommand('low', t('thinking.effort.low')),
    makeEffortSubCommand('medium', t('thinking.effort.medium')),
    makeEffortSubCommand('high', t('thinking.effort.high')),
    makeEffortSubCommand('xhigh', t('thinking.effort.xhigh')),
    makeEffortSubCommand('max', t('thinking.effort.max')),
    {
      name: 'status',
      description: t('thinking.usage.status'),
      kind: CommandKind.BUILT_IN,
      action: async (context) => showStatus(context),
    },
    // `on` 在补全菜单中隐藏（极简设计：引导用户直接选具体强度），
    // 但仍可手动输入 `/thinking on`，等价于高强度开启。
    {
      name: 'on',
      description: t('thinking.usage.on'),
      kind: CommandKind.BUILT_IN,
      hidden: true,
      action: async (context) => applyThinking(context, 'on', 'high'),
    },
  ],
};
