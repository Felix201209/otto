/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Otto /insert 命令 — 任务进行中插入需求和队列管理
 *
 * 命令:
 *   /insert status      - 查看插入引擎状态
 *   /insert queue       - 查看待处理队列
 *   /insert cancel <id> - 取消某条插入请求
 *   /insert resume      - 手动恢复被中断的任务
 *   /insert clean       - 清理已完成的请求
 */

import { SlashCommand, MessageActionReturn, CommandKind } from './types.js';
import { getInsertionEngine } from 'otto-core';

// ============================================================
// /insert status
// ============================================================

const statusCommand: SlashCommand = {
  name: 'status',
  description: '查看插入引擎当前状态',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    try {
      const engine = getInsertionEngine();
      const stats = engine.getStats();
      const currentTask = engine.getCurrentTask();
      const hasInterrupted = engine.hasInterruptedTask();

      let msg = `🔀 插入引擎状态\n\n`;
      msg += `📋 总排队: ${stats.totalQueued}\n`;
      msg += `⏳ 待处理: ${stats.pending}\n`;
      msg += `⚡ 执行中: ${stats.executing}\n`;
      msg += `✅ 已完成: ${stats.completed}\n`;
      msg += `❌ 失败: ${stats.failed}\n\n`;

      if (currentTask) {
        const remaining = currentTask.remainingSteps.length;
        msg += `📌 当前任务: "${currentTask.description}"\n`;
        msg += `   ➡️ 当前步骤: ${currentTask.currentStep}\n`;
        msg += `   ⏳ 剩余步骤: ${remaining}\n`;
      } else {
        msg += `💤 当前无执行中的任务\n`;
      }

      if (hasInterrupted) {
        msg += `\n⏸️ 有被中断的任务等待恢复 (使用 /insert resume)\n`;
      }

      msg += `\n💡 在对话中直接输入短查询即可触发插入检测\n`;
      msg += `   (例如: "等一下查张三日程" → 中断-恢复模式)`;

      return { type: 'message', messageType: 'info', content: msg };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 获取状态失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /insert queue
// ============================================================

const queueCommand: SlashCommand = {
  name: 'queue',
  description: '查看待处理的插入请求队列',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    try {
      const engine = getInsertionEngine();
      const pending = engine.getPendingQueue();

      if (pending.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: '📭 插入队列为空，没有待处理的插入请求。',
        };
      }

      let msg = `📋 插入请求队列 (${pending.length} 条)\n\n`;
      for (let i = 0; i < pending.length; i++) {
        const req = pending[i];
        const preview = req.originalInput.length > 60
          ? req.originalInput.substring(0, 60) + '...'
          : req.originalInput;
        const strategyLabel: Record<string, string> = {
          interrupt_and_resume: '⏸️ 中断-恢复',
          queue_when_done: '📋 排队',
          parallel_fork: '🔀 分叉',
          append_to_context: '📌 追加',
        };
        msg += `${i + 1}. \`${req.id.substring(0, 16)}...\` ${strategyLabel[req.strategy] || req.strategy}\n`;
        msg += `   ${preview}\n`;
        msg += `   创建于: ${new Date(req.createdAt).toLocaleString('zh-CN')}\n\n`;
      }

      msg += `💡 使用 /insert cancel <id> 取消指定请求`;

      return { type: 'message', messageType: 'info', content: msg };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 获取队列失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /insert cancel
// ============================================================

const cancelCommand: SlashCommand = {
  name: 'cancel',
  description: '取消指定的插入请求',
  kind: CommandKind.BUILT_IN,
  action: async (_context, args): Promise<MessageActionReturn> => {
    const requestId = args.trim();
    if (!requestId) {
      return { type: 'message', messageType: 'error', content: '❌ 请指定请求 ID\n用法: /insert cancel <requestId>' };
    }
    try {
      const engine = getInsertionEngine();
      await engine.completeRequest(requestId, '[用户取消]');
      return { type: 'message', messageType: 'info', content: `❌ 已取消请求: ${requestId}` };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 取消失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /insert resume
// ============================================================

const resumeCommand: SlashCommand = {
  name: 'resume',
  description: '恢复被中断的主任务',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    try {
      const engine = getInsertionEngine();
      if (!engine.hasInterruptedTask()) {
        return { type: 'message', messageType: 'info', content: '💤 当前没有被中断的任务需要恢复。' };
      }
      const task = await engine.resumeInterruptedTask();
      if (!task) {
        return { type: 'message', messageType: 'error', content: '❌ 恢复失败：找不到被中断的任务上下文。' };
      }
      return {
        type: 'message',
        messageType: 'info',
        content: `▶️ 已恢复主任务\n\n📌 "${task.description}"\n➡️ 当前: ${task.currentStep}\n⏳ 剩余: ${task.remainingSteps.length} 步\n\n继续执行中...`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 恢复失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /insert clean
// ============================================================

const cleanCommand: SlashCommand = {
  name: 'clean',
  description: '清理已完成的插入请求记录',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    try {
      const engine = getInsertionEngine();
      const count = await engine.cleanCompleted();
      return {
        type: 'message',
        messageType: 'info',
        content: `🧹 已清理 ${count} 条已完成/已跳过的请求`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 清理失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /insert help
// ============================================================

const helpCommand: SlashCommand = {
  name: 'help',
  description: '插入引擎使用帮助',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    return {
      type: 'message',
      messageType: 'info',
      content: `📖 插入引擎使用帮助\n\n` +
        `当 Otto 正在执行长任务时，你可以随时插入新需求。\n\n` +
        `🔄 自动检测:\n` +
        `  直接在对话中输入短查询就会自动触发插入检测:\n` +
        `  • "等一下，先帮我查张三日程" → 中断并恢复\n` +
        `  • "加上日志记录功能" → 追加到当前任务\n` +
        `  • "查一下今天的天气" → 分叉并行执行\n` +
        `  • "分析完代码后帮忙优化" → 排队等待\n\n` +
        `📋 队列管理:\n` +
        `  • /insert status   - 查看当前状态\n` +
        `  • /insert queue    - 查看待处理请求\n` +
        `  • /insert cancel   - 取消请求\n` +
        `  • /insert resume   - 恢复被中断的任务\n` +
        `  • /insert clean    - 清理已完成记录\n\n` +
        `💡 提示: 插入功能在非交互模式下也会自动生效`,
    };
  },
};

// ============================================================
// 母命令 /insert
// ============================================================

export const insertCommand: SlashCommand = {
  name: 'insert',
  description: '🔀 任务插入与队列管理',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    statusCommand,
    queueCommand,
    cancelCommand,
    resumeCommand,
    cleanCommand,
    helpCommand,
  ],
};
