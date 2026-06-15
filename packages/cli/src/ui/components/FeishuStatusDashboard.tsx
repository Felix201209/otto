/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { t, tp } from '../utils/i18n.js';

// ── 类型定义 ──────────────────────────────────────────────

export interface FeishuProjectRoute {
  projectRoot?: string;
  description?: string;
  model?: string;
  thinking?: {
    mode: 'on' | 'off' | 'auto';
    effort?: 'auto' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  };
  lastSessionId?: string;
}

export interface FeishuMessageLogEntry {
  chatId: string;
  text: string;
  /** 方向: 'in'=飞书→Agent, 'out'=Agent→飞书回复, 'tool'=工具调用 */
  direction: 'in' | 'out' | 'tool';
  timestamp: number;
}

export interface FeishuStatusDashboardProps {
  routes: Record<string, FeishuProjectRoute>;
  /** 「当前正在干活（Agent 仍在处理）」的群集合，可同时多个。 */
  activeGroupChatIds: Set<string>;
  groupLogs: Record<string, FeishuMessageLogEntry[]>;
  botName: string;
  platform: string;
  isConnected: boolean;
  terminalWidth: number;
  /** chatId → 群名 的解析结果（尽力而为）。有群名时优先展示群名，否则 fallback 到 chatId。 */
  chatNames?: Record<string, string>;
  /**
   * 经飞书 chat_mode 判定为 p2p 单聊（与 Bot 的私聊）的 chatId 集合。
   * 命中时展示「与机器人 X 的私聊」而非 chatId——p2p 单聊本身无群名，
   * 且与无名群/无权限群的 chatId 同为 oc_ 前缀，必须靠 chat_mode 精确区分。
   */
  p2pChatIds?: Set<string>;
}

// ── 辅助 ──────────────────────────────────────────────────

/** 截断聊天 ID，取后 8 位便于阅读 */
function shortChatId(id: string): string {
  return id.length > 12 ? `...${id.slice(-8)}` : id;
}

/** 从路径取最后两级目录名 */
function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2
    ? `.../${parts.slice(-2).join('/')}`
    : p;
}

/** 格式化时间戳 (HH:MM:SS) */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

/** 方向图标 */
function directionIcon(dir: 'in' | 'out' | 'tool'): string {
  switch (dir) {
    case 'in': return '◀';
    case 'out': return '▶';
    case 'tool': return '🔧';
  }
}

// ── 组件 ──────────────────────────────────────────────────

const MAX_VISIBLE_LOG_LINES = 5; // 可见窗口行数

export const FeishuStatusDashboard: React.FC<FeishuStatusDashboardProps> = ({
  routes,
  activeGroupChatIds,
  groupLogs,
  botName,
  platform,
  isConnected,
  terminalWidth,
  chatNames,
  p2pChatIds,
}) => {
  const routeEntries = Object.entries(routes);
  const hasActiveGroups = activeGroupChatIds.size > 0;

  // 🚀 限制最多展示 3 个绑定项目，防止群过多时撑爆终端高度导致滚动，从而造成 Ink 缓存清空失败而疯狂刷屏！
  //    优先按“当前活跃”排序，确保正在对话的群绝对可见，多余的项目展示折叠概要。
  const sortedRouteEntries = [...routeEntries].sort(([idA], [idB]) => {
    const actA = activeGroupChatIds.has(idA) ? 1 : 0;
    const actB = activeGroupChatIds.has(idB) ? 1 : 0;
    return actB - actA;
  });

  const MAX_VISIBLE_PROJECTS = 8;
  const visibleProjects = sortedRouteEntries.slice(0, MAX_VISIBLE_PROJECTS);
  const remainingCount = sortedRouteEntries.length - MAX_VISIBLE_PROJECTS;

  // ── 日志窗口聚焦的群 ──
  // 可能多个群同时在干活；日志窗口只展示一个，选「正在干活的群中最近有日志活动」的那个，
  // 让窗口跟随当前最活跃的对话。
  const focusedChatId: string | null = (() => {
    if (!hasActiveGroups) return null;
    let best: string | null = null;
    let bestTs = -1;
    for (const chatId of activeGroupChatIds) {
      const logs = groupLogs[chatId];
      const lastTs = logs && logs.length > 0 ? logs[logs.length - 1].timestamp : 0;
      if (lastTs >= bestTs) {
        bestTs = lastTs;
        best = chatId;
      }
    }
    return best;
  })();

  // ── 聚焦群的最新日志 (最多 MAX_VISIBLE_LOG_LINES 条) ──
  const activeLogs: FeishuMessageLogEntry[] = focusedChatId
    ? (groupLogs[focusedChatId] ?? []).slice(-MAX_VISIBLE_LOG_LINES)
    : [];

  return (
    <Box
      paddingX={1}
      paddingY={0}
      marginBottom={1}
      flexDirection="column"
      width={Math.min(terminalWidth, 100)}
    >
      {/* ── 顶部状态栏 ── */}
      <Box justifyContent="space-between" marginBottom={0}>
        <Text bold color={Colors.AccentCyan}>
          {platform === 'lark' ? t('feishu.dashboard.mode_lark') : t('feishu.dashboard.mode_feishu')}
        </Text>
        <Text>
          {isConnected ? (
            <Text color={Colors.AccentGreen}>● {t('feishu.dashboard.connected')}</Text>
          ) : (
            <Text color={Colors.AccentRed}>● {t('feishu.dashboard.disconnected')}</Text>
          )}
        </Text>
      </Box>

      <Box>
        <Text dimColor>
          {t('feishu.dashboard.bot_name')}: {botName || t('feishu.start.bot_unknown')}
        </Text>
      </Box>

      {/* ── 换行留白代替分隔线 ── */}
      <Box marginTop={1} />

      {/* ── 绑定项目列表 ── */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={Colors.AccentYellow}>
          {t('feishu.dashboard.bound_projects')} ({routeEntries.length})
        </Text>

        {routeEntries.length === 0 ? (
          <Box marginLeft={1} marginTop={1}>
            <Text dimColor>{t('feishu.dashboard.no_projects')}</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={0}>
            {visibleProjects.map(([chatId, route]) => {
              const isActive = activeGroupChatIds.has(chatId);
              // 显示名优先级：p2p 单聊文案 > 已解析群名 > chatId（宽屏完整 / 窄屏截断）。
              // p2p 判定优先于群名，避免上游误传 name 时把私聊显示成群名。
              const resolvedName = chatNames?.[chatId];
              const isWide = terminalWidth >= 85;
              const isP2p = p2pChatIds?.has(chatId) ?? false;
              const chatIdToShow = isP2p
                ? (botName
                    ? tp('feishu.status.p2p_chat_label', { bot: botName })
                    : t('feishu.status.p2p_chat_label_unknown'))
                : resolvedName
                  ? resolvedName
                  : isWide ? chatId : shortChatId(chatId);
              return (
                <Box key={chatId} justifyContent="space-between" marginTop={0}>
                  <Box>
                    {isActive ? (
                      <Text color={Colors.AccentGreen} bold>
                        🟢 {chatIdToShow} <Text color={Colors.AccentGreen} dimColor>({t('feishu.dashboard.active').replace('🟢 ', '')})</Text>
                      </Text>
                    ) : (
                      <Text dimColor>
                        {'   '}{chatIdToShow}
                      </Text>
                    )}
                  </Box>
                  {route.projectRoot ? (
                    <Text color={isActive ? Colors.AccentGreen : Colors.Gray} dimColor={!isActive}>
                      📂 {shortPath(route.projectRoot)}
                    </Text>
                  ) : null}
                </Box>
              );
            })}
            {remainingCount > 0 ? (
              <Box marginLeft={3} marginTop={0}>
                <Text color={Colors.Gray} dimColor>
                  ... ⏳ and {remainingCount} other bound projects (hidden to fit terminal height)
                </Text>
              </Box>
            ) : null}
          </Box>
        )}
      </Box>

      {/* ── 活跃群的消息滚动窗口 ── */}
      {focusedChatId && activeLogs.length > 0 ? (
        <Box
          flexDirection="column"
          marginTop={1}
          paddingLeft={1}
        >
          <Box marginBottom={0}>
            <Text bold color={Colors.AccentCyan}>
              {t('feishu.dashboard.message_log')}
            </Text>
          </Box>
          {/* 用固定高度的滚动窗口展示最近消息 */}
          <Box flexDirection="column" minHeight={MAX_VISIBLE_LOG_LINES + 1}>
            {activeLogs.map((entry, i) => {
              const time = fmtTime(entry.timestamp);
              const icon = directionIcon(entry.direction);
              const displayText = entry.text.length > terminalWidth - 24
                ? entry.text.slice(0, terminalWidth - 27) + '...'
                : entry.text;
              return (
                <Box key={i} flexDirection="row" paddingLeft={1}>
                  <Text color={Colors.Gray} dimColor>{time}</Text>
                  <Text>{' '}</Text>
                  <Text
                    color={
                      entry.direction === 'in'
                        ? Colors.AccentGreen
                        : entry.direction === 'out'
                          ? Colors.AccentBlue
                          : Colors.AccentYellow
                    }
                  >
                    {icon}
                  </Text>
                  <Text>{' '}</Text>
                  <Text wrap="truncate">{displayText}</Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : focusedChatId ? (
        <Box marginTop={1} marginLeft={1}>
          <Text dimColor>{t('feishu.dashboard.waiting')}</Text>
        </Box>
      ) : routeEntries.length > 0 ? (
        <Box marginTop={1} marginLeft={1}>
          <Text dimColor>{t('feishu.dashboard.idle')}</Text>
        </Box>
      ) : null}

      {/* ── 底部提示 ── */}
      <Box marginTop={1}>
        <Text dimColor>
          {t('feishu.dashboard.hint_stop')}
        </Text>
      </Box>
    </Box>
  );
};
