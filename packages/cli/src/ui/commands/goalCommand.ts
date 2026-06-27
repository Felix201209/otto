/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * /goal — 目标驱动模式（Goal-Driven Mode）
 *
 * 子命令：
 *   /goal           直接打开 GoalWizard 多步表单（与 /goal new 等价）。
 *   /goal new       同上，显式语义；存在的主要原因是补全 UX：
 *                   只有 clear 一个子命令时，自动补全会默认选中它，
 *                   用户回车就会误触清理动作。加 new 后补全菜单里
 *                   有两个对等选项（new / clear），不再"默认 clear"。
 *   /goal clear     主动结束当前 goal 模式（释放契约约束）。
 *
 * 启动流程（rootAction 与 newAction 共用 openWizard 实现）：
 *   收集任务描述 / 禁止事项 / 达标特征 / 最低工时 / 强度档位 → 确认 →
 *   useGoalWizard.handleComplete 拼装 prompt + setGoalContext + submitQuery。
 *
 * 清理流程（/goal clear）：
 *   - 调用 OttoClient.clearGoalContext() 释放内存里的 activeGoalContext，
 *     这样后续自动/手动压缩不再注入原 goal prompt。
 *   - 注入一条系统消息（buildGoalClearMessage）告诉模型契约已作废，
 *     防止它继续按"必须工作满 N 小时"的纪律推进。
 *
 * 设计要点：
 *   - 启动 action 仅返回 'dialog'；真正的提交逻辑放在 useGoalWizard.handleComplete，
 *     因为只有那里能闭包访问到 submitQuery。这与 debateCommand 的做法一致。
 *   - clear action 返回 'submit_prompt' (silent)，复用命令系统标准的注入路径，
 *     不需要额外打通 submitQuery ref。
 */

import {
  CommandContext,
  CommandKind,
  MessageActionReturn,
  OpenDialogActionReturn,
  SlashCommand,
  SubmitPromptActionReturn,
} from './types.js';
import { buildGoalClearMessage } from 'otto-core';
import { MessageType } from '../types.js';
import { t } from '../utils/i18n.js';

/**
 * 共享的"打开 wizard"逻辑。rootAction（裸 /goal）和 newAction（/goal new）
 * 都走这里，行为完全一致——避免两边逻辑漂移。
 */
const openWizard = async (
  context: CommandContext,
): Promise<MessageActionReturn | OpenDialogActionReturn> => {
  const { config } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('goalCommand.config_not_ready'),
    };
  }

  return {
    type: 'dialog',
    dialog: 'goal-wizard',
  };
};

const clearAction = async (
  context: CommandContext,
): Promise<MessageActionReturn | SubmitPromptActionReturn> => {
  const { config } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('goalCommand.config_not_ready'),
    };
  }

  // 检查当前是否处于 goal 模式 —— 没启动过就直接告知用户。
  // getOttoClient() 在 CLI 启动早期可能还没就绪；同样按"未激活"处理。
  let isActive = false;
  try {
    const client = config.getOttoClient();
    isActive = !!client?.getGoalContext();
    if (isActive) {
      // 释放内存里的 goal context 状态。
      // 必须在 submit_prompt 返回前完成 —— submit_prompt 会触发模型新一轮，
      // 那一轮如果触发自动压缩，已经清干净的 activeGoalContext 就不会再
      // 注入旧的 continuation 了。
      client!.clearGoalContext();
    }
  } catch (err) {
    // getOttoClient 抛错时按"未激活"处理：依然返回 info 提示，
    // 不影响用户后续操作。
    void err;
  }

  if (!isActive) {
    return {
      type: 'message',
      messageType: 'info',
      content: t('goalCommand.clear.not_active'),
    };
  }

  // UI 通知用户清理动作已生效。
  context.ui.addItem(
    {
      type: MessageType.INFO,
      text: t('goalCommand.clear.cleared_announce'),
    },
    Date.now(),
  );

  // 注入系统消息让模型知道契约作废。silent=true：内容是给模型看的纪律
  // 通知，不需要在前端再渲染一次（上面 addItem 的 info 行已是用户可见
  // 的清理痕迹，与 /goal 启动时的 announce 风格一致）。
  return {
    type: 'submit_prompt',
    content: buildGoalClearMessage(),
    silent: true,
  };
};

const newSubCommand: SlashCommand = {
  name: 'new',
  description: t('goalCommand.new.description'),
  kind: CommandKind.BUILT_IN,
  action: openWizard,
};

const clearSubCommand: SlashCommand = {
  name: 'clear',
  description: t('goalCommand.clear.description'),
  kind: CommandKind.BUILT_IN,
  action: clearAction,
};

export const goalCommand: SlashCommand = {
  name: 'goal',
  description: t('goalCommand.description'),
  kind: CommandKind.BUILT_IN,
  action: openWizard,
  // 子命令顺序故意是 [new, clear]：补全菜单按数组顺序展示，把"启动"放
  // 在第一位，让默认高亮项是更常见的"新建"动作而不是"清理"。
  subCommands: [newSubCommand, clearSubCommand],
};
