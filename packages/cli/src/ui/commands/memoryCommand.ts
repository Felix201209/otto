/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 *
 * Otto /memory 命令 — 记忆自动合并分割管理
 *
 * 命令:
 *   /memory stats        - 记忆统计
 *   /memory merge        - 手动触发合并检测
 *   /memory split        - 手动触发分割检测
 *   /memory compress     - 压缩老旧记忆
 *   /memory maintain     - 执行完整维护周期
 *   /memory list         - 列出记忆条目
 *   /memory clean        - 清理过期记忆
 */

import { SlashCommand, MessageActionReturn, CommandKind } from './types.js';
import { getAutoMemoryEngine } from 'otto-core';
import { homedir } from 'os';
import path from 'path';

// ============================================================
// /memory stats
// ============================================================

const statsCommand: SlashCommand = {
  name: 'stats',
  description: '查看记忆引擎统计信息',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    try {
      const engine = getAutoMemoryEngine();
      await engine.initialize();

      const stats = engine.getStats();
      const scopeBreakdown = Object.entries(stats.byScope)
        .map(([scope, count]) => `  • ${scope}: ${count}`)
        .join('\n');

      return {
        type: 'message',
        messageType: 'info',
        content: `🧠 记忆引擎统计\n\n` +
          `📦 总条目数: ${stats.totalEntries}\n` +
          `📊 按作用域:\n${scopeBreakdown || '  无'}\n` +
          `📏 估算 Token: ${stats.totalEstimatedTokens.toLocaleString()}\n` +
          `🗜️ 压缩率: ${(stats.compressionRatio * 100).toFixed(1)}%\n` +
          `🕐 最老条目: ${stats.oldestEntry ? new Date(stats.oldestEntry).toLocaleString('zh-CN') : '无'}\n` +
          `🆕 最新条目: ${stats.newestEntry ? new Date(stats.newestEntry).toLocaleString('zh-CN') : '无'}`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 获取记忆统计失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /memory merge
// ============================================================

const mergeCommand: SlashCommand = {
  name: 'merge',
  description: '检测并执行记忆合并',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    try {
      const engine = getAutoMemoryEngine();
      await engine.initialize();

      const candidates = await engine.detectMergeCandidates();
      if (candidates.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: '✅ 未检测到可合并的记忆条目。记忆状态良好！',
        };
      }

      let merged = 0;
      for (const c of candidates.slice(0, 10)) {
        const result = await engine.applyMerge(c);
        if (result) merged++;
      }

      return {
        type: 'message',
        messageType: 'info',
        content: `🔗 记忆合并完成\n\n` +
          `🔍 检测到 ${candidates.length} 组可合并条目\n` +
          `✅ 已合并 ${merged} 组\n` +
          `${merged < candidates.length ? `💡 余下 ${candidates.length - merged} 组可使用 /memory merge 再次尝试` : ''}`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 合并失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /memory split
// ============================================================

const splitCommand: SlashCommand = {
  name: 'split',
  description: '检测并执行记忆分割',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    try {
      const engine = getAutoMemoryEngine();
      await engine.initialize();

      const candidates = await engine.detectSplitCandidates();
      if (candidates.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: '✅ 未检测到需要分割的记忆条目。',
        };
      }

      let split = 0;
      for (const c of candidates.slice(0, 5)) {
        const result = await engine.applySplit(c);
        if (result.length > 0) split++;
      }

      return {
        type: 'message',
        messageType: 'info',
        content: `✂️ 记忆分割完成\n\n` +
          `🔍 检测到 ${candidates.length} 条需要分割\n` +
          `✅ 已分割 ${split} 条\n` +
          `${split < candidates.length ? `💡 余下 ${candidates.length - split} 条可使用 /memory split 再次尝试` : ''}`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 分割失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /memory compress
// ============================================================

const compressCommand: SlashCommand = {
  name: 'compress',
  description: '压缩老旧记忆条目',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    try {
      const engine = getAutoMemoryEngine();
      await engine.initialize();

      const results = await engine.compressOldMemories();
      if (results.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: '✅ 无需压缩，所有记忆条目都足够新。',
        };
      }

      return {
        type: 'message',
        messageType: 'info',
        content: `🗜️ 记忆压缩完成\n\n` +
          `📦 压缩了 ${results.length} 组老旧记忆\n` +
          `📝 压缩后的摘要已作为新条目保存\n` +
          `💡 使用 /memory stats 查看压缩率`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 压缩失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /memory maintain
// ============================================================

const maintainCommand: SlashCommand = {
  name: 'maintain',
  description: '执行完整记忆维护周期（合并+分割+压缩+清理）',
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<MessageActionReturn> => {
    try {
      const engine = getAutoMemoryEngine();
      await engine.initialize();

      const result = await engine.runMaintenanceCycle();

      return {
        type: 'message',
        messageType: 'info',
        content: `🔄 记忆维护周期完成\n\n` +
          `🔗 合并: ${result.merges} 组\n` +
          `✂️ 分割: ${result.splits} 条\n` +
          `🗜️ 压缩: ${result.compressions} 组\n` +
          `🧹 清理: ${result.cleanups} 条过期条目\n\n` +
          `💡 记忆引擎会在维护周期外自动触发合并/分割，无需手动干预`,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `❌ 维护失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================
// /memory list
// ============================================================

const listCommand: SlashCommand = {
  name: 'list',
  description: '列出当前记忆条目',
  kind: CommandKind.BUILT_IN,
  action: async (_context, args): Promise<MessageActionReturn> => {
    try {
      const engine = getAutoMemoryEngine();
      await engine.initialize();

      const parts = args.trim().split(/\s+/);
      const scope = parts.find(p => ['global', 'project', 'session'].includes(p)) as 'global' | 'project' | 'session' | undefined;
      const limitIdx = parts.indexOf('--limit');
      const limit = limitIdx >= 0 ? parseInt(parts[limitIdx + 1], 10) || 20 : 20;

      const entries = engine.queryEntries({ scope, limit });

      if (entries.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: `📭 ${scope ? `作用域 "${scope}" 中` : ''}没有找到记忆条目。`,
        };
      }

      let msg = `📝 记忆条目 (${entries.length})\n`;
      if (scope) msg += `  作用域: ${scope}\n`;
      msg += '\n';

      for (const e of entries) {
        const preview = e.text.length > 80 ? e.text.substring(0, 80) + '...' : e.text;
        const accessInfo = `[访问 ${e.accessCount} 次]`;
        msg += `• \`${e.id.substring(0, 16)}...\` ${accessInfo} ${e.compressed ? '🗜️' : ''}\n`;
        msg += `  ${e.topics.map(t => `\`${t}\``).join(' ')}\n`;
        msg += `  ${preview}\n\n`;
      }

      msg += `💡 使用 /memory stats 查看详细统计`;

      return { type: 'message', messageType: 'info', content: msg };
    } catch (error) {
      return { type: 'message', messageType: 'error', content: `❌ 列出失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};

// ============================================================
// /memory clean
// ============================================================

const cleanCommand: SlashCommand = {
  name: 'clean',
  description: '清理过期记忆条目',
  kind: CommandKind.BUILT_IN,
  action: async (_context, args): Promise<MessageActionReturn> => {
    const days = parseInt(args.trim(), 10) || 90;
    try {
      const engine = getAutoMemoryEngine();
      await engine.initialize();
      const count = await engine.cleanExpiredMemories();
      return {
        type: 'message',
        messageType: 'info',
        content: `🧹 已清理 ${count} 条超过 ${days} 天的过期记忆条目`,
      };
    } catch (error) {
      return { type: 'message', messageType: 'error', content: `❌ 清理失败: ${error instanceof Error ? error.message : String(error)}` };
    }
  },
};

// ============================================================
// 母命令 /memory
// ============================================================

export const memoryCommand: SlashCommand = {
  name: 'memory',
  description: '🧠 记忆自动管理（合并/分割/压缩/维护）',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    statsCommand,
    mergeCommand,
    splitCommand,
    compressCommand,
    maintainCommand,
    listCommand,
    cleanCommand,
  ],
};
