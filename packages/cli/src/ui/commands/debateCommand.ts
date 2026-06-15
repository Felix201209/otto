/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * /debate — multi-model review/debate mode.
 *
 * Main entry:
 *   /debate              → opens DebateWizard dialog. User picks a saved preset
 *                          or configures a new one (models + rounds + topic).
 *                          On confirm, command saves the preset and kicks off
 *                          the debate by switching to the first model and
 *                          submitting an opening phrase (as a user-role msg).
 *
 * Sub-commands:
 *   /debate continue     → resume a paused debate from the saved cursor.
 *   /debate end          → force-end the current debate.
 *   /debate status       → show current debate state.
 *
 * Auto-advance is handled in useGeminiStream.ts: when a turn finishes while
 * a debate is running, the hook advances the cursor, switches models, and
 * submits the next mediator phrase automatically.
 */

import process from 'node:process';
import {
  CommandContext,
  CommandKind,
  MessageActionReturn,
  OpenDialogActionReturn,
  SlashCommand,
} from './types.js';
import {
  endDebate,
  getActiveDebate,
} from '../utils/debateState.js';
import { loadPresets } from '../utils/debateStorage.js';

/**
 * Main /debate command — opens the wizard.
 *
 * We return an OpenDialogActionReturn of type 'debate-wizard'. The actual
 * start-of-debate work happens in App.tsx when the wizard's onComplete fires,
 * because only App.tsx has access to geminiClient.switchModel() and
 * submitQuery() (which live inside React hooks).
 */
const rootAction = async (
  context: CommandContext,
): Promise<MessageActionReturn | OpenDialogActionReturn> => {
  const { config } = context.services;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: '❌ 配置未就绪，无法启动辩论模式',
    };
  }

  // If a debate is already running/paused, steer the user instead of stacking.
  const existing = getActiveDebate();
  if (existing && existing.status !== 'done') {
    return {
      type: 'message',
      messageType: 'info',
      content:
        `⚠️ 已经有一场辩论正在进行（状态：${existing.status}）。\n` +
        `   • /debate continue — 继续当前辩论\n` +
        `   • /debate end — 强制结束\n` +
        `   • /debate status — 查看详情`,
    };
  }

  // Open the wizard. Presets are loaded inside App.tsx when rendering the
  // dialog (they're per-project, and App has projectRoot), so we don't pass
  // them here. Dialog metadata kept empty.
  return {
    type: 'dialog',
    dialog: 'debate-wizard',
  };
};

// ---------- sub-commands ----------

const newCommand: SlashCommand = {
  name: 'new',
  description: '开始新的辩论（打开配置向导）',
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
  ): Promise<MessageActionReturn | OpenDialogActionReturn> => {
    const { config } = context.services;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: '❌ 配置未就绪，无法启动辩论模式',
      };
    }
    const existing = getActiveDebate();
    if (existing && existing.status !== 'done') {
      return {
        type: 'message',
        messageType: 'info',
        content:
          `⚠️ 已经有一场辩论正在进行（状态：${existing.status}）。\n` +
          `   • /debate continue — 继续当前辩论\n` +
          `   • /debate end — 强制结束`,
      };
    }
    return {
      type: 'dialog',
      dialog: 'debate-wizard',
    };
  },
};

const continueCommand: SlashCommand = {
  name: 'continue',
  description: '继续被暂停的辩论',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<
    MessageActionReturn | OpenDialogActionReturn
  > => {
    const debate = getActiveDebate();
    if (!debate) {
      return {
        type: 'message',
        messageType: 'info',
        content: '当前没有辩论。用 /debate 开始一场新的辩论。',
      };
    }
    if (debate.status === 'done') {
      return {
        type: 'message',
        messageType: 'info',
        content: '上一场辩论已结束。用 /debate 开始新的。',
      };
    }
    if (debate.status === 'running') {
      return {
        type: 'message',
        messageType: 'info',
        content: '辩论正在进行中，无需 continue。',
      };
    }
    // status === 'paused' —— 路由到 App.tsx 的 debate-resume handler，
    // 那里有 geminiClient 和 submitQuery 的闭包访问，能正确地：
    //   1) 计算下一位，2) switchModel，3) advanceCursor，4) submit followup
    // 直接在此处返回 submit_prompt 会跳过 switchModel，导致用旧模型再发言一轮。
    return {
      type: 'dialog',
      dialog: 'debate-resume',
    };
  },
};

const endCommand: SlashCommand = {
  name: 'end',
  description: '强制结束当前辩论',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    const debate = getActiveDebate();
    if (!debate) {
      return {
        type: 'message',
        messageType: 'info',
        content: '当前没有进行中的辩论。',
      };
    }
    endDebate();
    return {
      type: 'message',
      messageType: 'info',
      content: '✓ 辩论已结束。',
    };
  },
};

const statusCommand: SlashCommand = {
  name: 'status',
  description: '查看当前辩论状态',
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext): Promise<MessageActionReturn> => {
    const debate = getActiveDebate();
    if (!debate) {
      const projectRoot = context.services.config?.getProjectRoot() || process.cwd();
      const presets = loadPresets(projectRoot);
      const presetLine =
        presets.length > 0
          ? `\n本项目保存了 ${presets.length} 个历史设定，用 /debate 查看。`
          : '';
      return {
        type: 'message',
        messageType: 'info',
        content: `当前没有进行中的辩论。${presetLine}`,
      };
    }
    // cursor 指向 CURRENT speaker（刚发言/正在发言的人）。
    const currentModel = debate.models[debate.cursor.modelIdx] ?? '(结束)';
    // 计算下一位。如果本人就是最后一轮最后一位，下一位就是"结束"。
    let nextModelIdx = debate.cursor.modelIdx + 1;
    let nextRound = debate.cursor.round;
    if (nextModelIdx >= debate.models.length) {
      nextModelIdx = 0;
      nextRound += 1;
    }
    const nextLabel =
      nextRound >= debate.rounds
        ? '(结束)'
        : debate.models[nextModelIdx] ?? '(结束)';

    const totalTurns = debate.models.length * debate.rounds;
    // 已完成发言数：cursor 从 (0,0) 起算。当 status 为 running 且模型正在开口时，
    // 算作“正在进行第 N 轮”，已完成数不包含当前这位。
    const doneTurns =
      debate.cursor.round * debate.models.length + debate.cursor.modelIdx;
    return {
      type: 'message',
      messageType: 'info',
      content:
        `🎭 辩论状态\n` +
        `   话题：${debate.topic}\n` +
        `   模型：${debate.models.join(' → ')}\n` +
        `   进度：${doneTurns}/${totalTurns} 轮（正在进行：${currentModel}，第 ${
          debate.cursor.round + 1
        } 轮；下一个：${nextLabel}）\n` +
        `   状态：${debate.status}`,
    };
  },
};

export const debateCommand: SlashCommand = {
  name: 'debate',
  description: '多模型辩论 / 代码 review 模式',
  kind: CommandKind.BUILT_IN,
  action: rootAction,
  subCommands: [newCommand, continueCommand, endCommand, statusCommand],
};
