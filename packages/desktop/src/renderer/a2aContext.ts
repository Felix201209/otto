/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * A2A 隐私边界：这里只读取接收方在单次请求中明确勾选的资料，并在进入
 * tool-free Agent 前做数量、字段和总长度裁剪。
 */

import type { ScheduleItemInfo } from 'otto-server';
import type {
  EnterpriseDirectMessage,
  EnterpriseKnowledgeItem,
} from '../preload/index.js';
import {
  ATOA_CONTEXT_SOURCES,
  type AtoaContextSource,
  displayDirectMessageContent,
} from './atoaProtocol.js';

interface WorkLogEntry {
  time: string;
  category: string;
  action: string;
  success: boolean;
  details?: string;
  entryType: 'tool' | 'work_result';
  taskTitle?: string;
}
interface WorkLogDay {
  date: string;
  entries: WorkLogEntry[];
}

export interface CollectAuthorizedAtoaContextInput {
  sources: readonly AtoaContextSource[];
  peerAccountId: string;
  currentAccountId: string;
  currentAccountName: string;
  peerName: string;
  /** Message IDs explicitly selected in the current one-time permission UI. */
  authorizedMessageIds?: readonly string[];
  listMessages(peerAccountId: string): Promise<EnterpriseDirectMessage[]>;
  listKnowledge(): Promise<EnterpriseKnowledgeItem[]>;
  workLogRecent(days?: number): Promise<WorkLogDay[]>;
  schedules: readonly ScheduleItemInfo[];
}

export interface AuthorizedAtoaContext {
  context: string;
  loadedSources: AtoaContextSource[];
  failedSources: Array<{ source: AtoaContextSource; reason: string }>;
}

const SOURCE_LABELS: Record<AtoaContextSource, string> = {
  current_chat: '当前聊天',
  enterprise_knowledge: '企业知识',
  work_logs: '工作日志',
  schedules: '日程',
};

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

function errorMessage(error: unknown): string {
  return text(error instanceof Error ? error.message : String(error), 200) || '未知错误';
}

function formatMessages(
  messages: EnterpriseDirectMessage[],
  input: CollectAuthorizedAtoaContextInput,
): string {
  const rows = messages.slice(-40).map((message) => {
    const speaker =
      message.senderAccountId === input.currentAccountId
        ? input.currentAccountName
        : input.peerName;
    return `- ${text(message.createdAt, 40)} ${text(speaker, 80)}: ${text(
      displayDirectMessageContent(message.content),
      500,
    )}`;
  });
  return rows.length > 0 ? rows.join('\n') : '（当前聊天没有消息）';
}

function formatKnowledge(items: EnterpriseKnowledgeItem[]): string {
  const rows = [...items]
    .filter((item) => !item.status || item.status === 'active')
    .sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
    .slice(0, 20)
    .map((item) => {
      const meta = [text(item.department, 80), text(item.category, 80)]
        .filter(Boolean)
        .join(' / ');
      const source = text(item.sourceLabel || item.sourceId, 120);
      const citation = `[企业知识#${text(item.id, 40)} v${item.version || 1}]`;
      return `- ${citation} ${text(item.title, 160) || meta || '知识'}${meta ? ` (${meta})` : ''}${source ? `；来源：${source}` : ''}: ${text(item.content, 500)}`;
    });
  return rows.length > 0 ? rows.join('\n') : '（没有可用企业知识）';
}

function formatWorkLogs(days: WorkLogDay[]): string {
  const rows = days.slice(0, 7).flatMap((day) =>
    day.entries.slice(0, 30).map((entry) => {
      const detail = text(entry.details, 240);
      return `- ${text(day.date, 20)} ${text(entry.time, 20)} ${text(
        entry.category,
        60,
      )}: ${text(entry.action, 400)}${detail ? `；${detail}` : ''}`;
    }),
  );
  return rows.length > 0 ? rows.join('\n') : '（最近 7 天没有工作日志）';
}

function formatSchedules(schedules: readonly ScheduleItemInfo[]): string {
  const rows = [...schedules]
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 30)
    .map((item) => {
      const notes = text(item.notes, 240);
      return `- ${text(item.startAt, 40)}${
        item.endAt ? ` 至 ${text(item.endAt, 40)}` : ''
      } ${text(item.title, 160)}${notes ? `；${notes}` : ''}`;
    });
  return rows.length > 0 ? rows.join('\n') : '（当前没有可用日程）';
}

export async function collectAuthorizedAtoaContext(
  input: CollectAuthorizedAtoaContextInput,
): Promise<AuthorizedAtoaContext> {
  const selected = ATOA_CONTEXT_SOURCES.filter((source) =>
    input.sources.includes(source),
  );
  if (selected.length === 0) {
    return {
      context: '本次未授权任何资料；只能依据对方问题回答，不得推断个人数据。',
      loadedSources: [],
      failedSources: [],
    };
  }

  const sections: string[] = [];
  const loadedSources: AtoaContextSource[] = [];
  const failedSources: Array<{ source: AtoaContextSource; reason: string }> = [];

  for (const source of selected) {
    try {
      let body: string;
      if (source === 'current_chat') {
        const authorized = new Set(
          (input.authorizedMessageIds ?? []).filter(
            (id) => typeof id === 'string' && id.length > 0 && id.length <= 200,
          ).slice(0, 40),
        );
        if (authorized.size === 0) {
          throw new Error('未明确选择任何私聊消息片段');
        }
        const selectedMessages = (
          await input.listMessages(input.peerAccountId)
        ).filter((message) => authorized.has(message.id));
        if (selectedMessages.length === 0) {
          throw new Error('所选私聊消息已不存在或不属于当前会话');
        }
        body = formatMessages(selectedMessages, input);
      } else if (source === 'enterprise_knowledge') {
        body = formatKnowledge(await input.listKnowledge());
      } else if (source === 'work_logs') {
        body = formatWorkLogs(await input.workLogRecent(7));
      } else {
        body = formatSchedules(input.schedules);
      }
      loadedSources.push(source);
      sections.push(`### ${SOURCE_LABELS[source]}\n${body}`);
    } catch (error) {
      const reason = errorMessage(error);
      failedSources.push({ source, reason });
      sections.push(`### ${SOURCE_LABELS[source]}：读取失败\n${reason}`);
    }
  }

  return {
    context: sections.join('\n\n').slice(0, 8000),
    loadedSources,
    failedSources,
  };
}
