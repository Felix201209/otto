/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Otto Session Manager 增强命令 — 合并/分割/路由
 * 扩展 /session 命令，增加:
 *   /session merge <id1> <id2> ... [--title "新标题"]
 *   /session split <id> [--strategy by_topic|by_token_count|by_time]
 *   /session stats
 *   /session rule add <pattern> <target> [--priority N] [--desc "说明"]
 *   /session rule list
 *   /session rule rm <id>
 *   /session archive <id>
 *   /session unarchive <id>
 *   /session bridge <from> <to> <payload>
 */

import { SlashCommand, MessageActionReturn, CommandKind } from './types.js';
import { getSessionManager } from 'otto-core';
import { t } from '../utils/i18n.js';

// ============================================================
// /session merge
// ============================================================

const mergeCommand: SlashCommand = {
  name: 'merge',
  description: '合并多个会话到新会话',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    try {
      const parts = args.trim().split(/\s+/);
      // 解析 --title 参数
      const titleIdx = parts.indexOf('--title');
      let title: string | undefined;
      let sessionIds: string[];
      if (titleIdx >= 0) {
        title = parts.slice(titleIdx + 1).join(' ');
        sessionIds = parts.slice(0, titleIdx);
      } else {
        // 也可能用 -t
        const tIdx = parts.indexOf('-t');
        if (tIdx >= 0) {
          title = parts.slice(tIdx + 1).join(' ');
          sessionIds = parts.slice(0, tIdx);
        } else {
          sessionIds = parts;
        }
      }

      if (sessionIds.length < 2) {
        return {
          type: 'message',
          messageType: 'error',
          content: `❌ 请提供至少两个 Session ID 进行合并。\n\n用法: /session merge <id1> <id2> ... [--title "新标题"]`,
        };
      }

      const mgr = getSessionManager();
      await mgr.initialize();
      const merged = await mgr.mergeSessions(sessionIds, title);

      if (!merged) {
        return {
          type: 'message',
          messageType: 'error',
          content: `❌ 合并失败：未找到有效的会话。`,
        };
      }

      return {
        type: 'message',
        messageType: 'info',
        content: `✅ 合并成功！\n\n📝 新会话: \`${merged.id}\`\n📌 标题: ${merged.title}\n🔀 来源: ${sessionIds.length} 个会话\n📊 总计消息数: ${merged.messageCount}\n🏷️ 主题: ${merged.topics.join(', ') || '无'}`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 合并失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
  completion: async (_context, _partialArg) => [],
};

// ============================================================
// /session split
// ============================================================

const splitCommand: SlashCommand = {
  name: 'split',
  description: '将会话按主题/数量/时间分割',
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<MessageActionReturn> => {
    try {
      const parts = args.trim().split(/\s+/);
      if (parts.length === 0) {
        return {
          type: 'message',
          messageType: 'error',
          content: '❌ 请指定 Session ID。\n\n用法: /session split <id> [--strategy by_topic|by_token_count|by_time]',
        };
      }

      const sessionId = parts[0];
      const strategyIdx = parts.indexOf('--strategy');
      const strategy = strategyIdx >= 0
        ? (parts[strategyIdx + 1] as 'by_topic' | 'by_token_count' | 'by_time')
        : 'by_topic';

      // 验证策略值
      if (!['by_topic', 'by_token_count', 'by_time'].includes(strategy)) {
        return {
          type: 'message',
          messageType: 'error',
          content: `❌ 无效的策略: "${strategy}"。可选: by_topic, by_token_count, by_time`,
        };
      }

      const mgr = getSessionManager();
      await mgr.initialize();
      const result = await mgr.splitSession(sessionId, strategy);

      if (!result) {
        return {
          type: 'message',
          messageType: 'error',
          content: `❌ 分割失败：未找到会话 "${sessionId}"`,
        };
      }

      return {
        type: 'message',
        messageType: 'info',
        content: `✅ 分割成功！\n\n📌 原会话: \`${result.original.id}\` (已归档)\n🔀 新会话: \`${result.fork.id}\`\n📋 策略: ${strategy}\n\n使用 /session switch ${result.fork.id} 切换到新会话`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 分割失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
  completion: async (_context, _partialArg) => [],
};

// ============================================================
// /session stats
// ============================================================

const statsCommand: SlashCommand = {
  name: 'stats',
  description: '查看会话管理器统计信息',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    try {
      const mgr = getSessionManager();
      await mgr.initialize();
      const stats = mgr.getStats();

      return {
        type: 'message',
        messageType: 'info',
        content: `📊 会话统计\n\n` +
          `📦 总计: ${stats.total}\n` +
          `🟢 活跃: ${stats.active}\n` +
          `💤 空闲: ${stats.idle}\n` +
          `📁 已归档: ${stats.archived}\n` +
          `❄️ 冻结: ${stats.frozen}\n\n` +
          `可用命令:\n` +
          `  /session list        - 列出所有会话\n` +
          `  /session merge ...   - 合并会话\n` +
          `  /session split <id>  - 分割会话\n` +
          `  /session archive <id> - 归档会话\n` +
          `  /session cleanup     - 清理过期会话`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 获取统计失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /session archive / unarchive / cleanup
// ============================================================

const archiveCommand: SlashCommand = {
  name: 'archive',
  description: '归档指定会话',
  kind: CommandKind.BUILT_IN,
  action: async (_context, args): Promise<MessageActionReturn> => {
    const sessionId = args.trim();
    if (!sessionId) {
      return { type: 'message', messageType: 'error', content: '❌ 请指定 Session ID' };
    }
    try {
      const mgr = getSessionManager();
      await mgr.initialize();
      await mgr.archiveSession(sessionId);
      return { type: 'message', messageType: 'info', content: `📁 已归档会话: ${sessionId}` };
    } catch (error) {
      return { type: 'message', messageType: 'error', content: `❌ 归档失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};

const unarchiveCommand: SlashCommand = {
  name: 'unarchive',
  description: '恢复已归档的会话',
  kind: CommandKind.BUILT_IN,
  action: async (_context, args): Promise<MessageActionReturn> => {
    const sessionId = args.trim();
    if (!sessionId) {
      return { type: 'message', messageType: 'error', content: '❌ 请指定 Session ID' };
    }
    try {
      const mgr = getSessionManager();
      await mgr.initialize();
      await mgr.unarchiveSession(sessionId);
      return { type: 'message', messageType: 'info', content: `🔄 已恢复会话: ${sessionId}` };
    } catch (error) {
      return { type: 'message', messageType: 'error', content: `❌ 恢复失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};

const cleanupSessionsCommand: SlashCommand = {
  name: 'cleanup',
  description: '清理超过指定天数的过期会话',
  kind: CommandKind.BUILT_IN,
  action: async (_context, args): Promise<MessageActionReturn> => {
    const days = parseInt(args.trim(), 10) || 30;
    try {
      const mgr = getSessionManager();
      await mgr.initialize();
      const count = await mgr.cleanExpiredSessions(days);
      return {
        type: 'message',
        messageType: 'info',
        content: `🧹 已清理 ${count} 个超过 ${days} 天的过期会话`,
      };
    } catch (error) {
      return { type: 'message', messageType: 'error', content: `❌ 清理失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};

// ============================================================
// /session bridge
// ============================================================

const bridgeCommand: SlashCommand = {
  name: 'bridge',
  description: '在两个会话间建立上下文桥梁',
  kind: CommandKind.BUILT_IN,
  action: async (_context, args): Promise<MessageActionReturn> => {
    // 格式: /session bridge <from> <to> <payload>
    const parts = args.trim().split(/\s+/);
    if (parts.length < 3) {
      return { type: 'message', messageType: 'error', content: '❌ 用法: /session bridge <fromSessionId> <toSessionId> <payload>' };
    }
    const [fromId, toId, ...payloadParts] = parts;
    const payload = payloadParts.join(' ');
    try {
      const mgr = getSessionManager();
      await mgr.initialize();
      await mgr.createBridge(fromId, toId, payload);
      return { type: 'message', messageType: 'info', content: `🌉 已建立桥梁: ${fromId} ↔ ${toId}` };
    } catch (error) {
      return { type: 'message', messageType: 'error', content: `❌ 建立桥梁失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};

// ============================================================
// 注册到 session 命令
// ============================================================

/**
 * 这是扩展子命令列表，需要注入到 sessionCommand.subCommands.
 * 在 BuiltinCommandLoader 加载时自动注册。
 */
export const sessionEnhanceCommands: SlashCommand[] = [
  mergeCommand,
  splitCommand,
  statsCommand,
  archiveCommand,
  unarchiveCommand,
  cleanupSessionsCommand,
  bridgeCommand,
];
