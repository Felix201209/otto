/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Otto 的本地日程单一事实源。桌面端与 Agent 都通过这份仓库读写
 * `~/.otto-user/schedules.json`，避免 UI 日历和 Agent 自主创建各存一套。
 */

import { Type } from '@google/genai';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { BaseTool, Icon, type ToolResult } from './tools.js';

export type LocalScheduleSource = 'user' | 'otto';

export interface LocalScheduleItem {
  id: string;
  title: string;
  startAt: string;
  endAt?: string;
  notes?: string;
  source: LocalScheduleSource;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLocalScheduleInput {
  title: string;
  startAt: string;
  endAt?: string;
  notes?: string;
  source: LocalScheduleSource;
  reason?: string;
}

export interface UpdateLocalScheduleInput {
  title?: string;
  startAt?: string;
  endAt?: string | null;
  notes?: string | null;
  reason?: string | null;
}

interface ScheduleFile {
  version: 1;
  schedules: LocalScheduleItem[];
}

const scheduleEvents = new EventEmitter();
scheduleEvents.setMaxListeners(50);

export function localScheduleFilePath(): string {
  const configured = process.env['OTTO_SCHEDULE_FILE']?.trim();
  return configured || path.join(os.homedir(), '.otto-user', 'schedules.json');
}

function readScheduleFile(): ScheduleFile {
  try {
    const raw = JSON.parse(fs.readFileSync(localScheduleFilePath(), 'utf8')) as Partial<ScheduleFile>;
    if (!Array.isArray(raw.schedules)) return { version: 1, schedules: [] };
    return {
      version: 1,
      schedules: raw.schedules.filter(isScheduleItem),
    };
  } catch {
    return { version: 1, schedules: [] };
  }
}

function isScheduleItem(value: unknown): value is LocalScheduleItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LocalScheduleItem>;
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    typeof item.startAt === 'string' &&
    (item.source === 'user' || item.source === 'otto') &&
    typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string'
  );
}

function writeScheduleFile(file: ScheduleFile): void {
  const filePath = localScheduleFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, filePath);
  scheduleEvents.emit('changed', file.schedules);
}

function validDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} 必须是合法的 ISO 日期时间`);
  }
  return parsed;
}

function validateTimeRange(startAt: string, endAt?: string): void {
  const start = validDate(startAt, '开始时间');
  if (!endAt) return;
  const end = validDate(endAt, '结束时间');
  if (end.getTime() < start.getTime()) {
    throw new Error('结束时间不能早于开始时间');
  }
}

function cleanOptional(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}

export function createLocalSchedule(input: CreateLocalScheduleInput): LocalScheduleItem {
  const title = input.title.trim();
  if (!title) throw new Error('日程标题不能为空');
  validateTimeRange(input.startAt, input.endAt);
  const now = new Date().toISOString();
  const item: LocalScheduleItem = {
    id: randomUUID(),
    title,
    startAt: new Date(input.startAt).toISOString(),
    ...(input.endAt ? { endAt: new Date(input.endAt).toISOString() } : {}),
    ...(cleanOptional(input.notes) ? { notes: cleanOptional(input.notes) } : {}),
    source: input.source,
    ...(cleanOptional(input.reason) ? { reason: cleanOptional(input.reason) } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const file = readScheduleFile();
  file.schedules.push(item);
  file.schedules.sort((a, b) => a.startAt.localeCompare(b.startAt));
  writeScheduleFile(file);
  return item;
}

export function updateLocalSchedule(
  id: string,
  patch: UpdateLocalScheduleInput,
): LocalScheduleItem {
  const file = readScheduleFile();
  const index = file.schedules.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('未找到要更新的日程');
  const current = file.schedules[index];
  const title = patch.title === undefined ? current.title : patch.title.trim();
  if (!title) throw new Error('日程标题不能为空');
  const startAt = patch.startAt ? new Date(validDate(patch.startAt, '开始时间')).toISOString() : current.startAt;
  const endAt = patch.endAt === null
    ? undefined
    : patch.endAt
      ? new Date(validDate(patch.endAt, '结束时间')).toISOString()
      : current.endAt;
  validateTimeRange(startAt, endAt);
  const next: LocalScheduleItem = {
    ...current,
    title,
    startAt,
    ...(endAt ? { endAt } : {}),
    notes: patch.notes === null ? undefined : cleanOptional(patch.notes) ?? current.notes,
    reason: patch.reason === null ? undefined : cleanOptional(patch.reason) ?? current.reason,
    updatedAt: new Date().toISOString(),
  };
  if (!endAt) delete next.endAt;
  if (!next.notes) delete next.notes;
  if (!next.reason) delete next.reason;
  file.schedules[index] = next;
  file.schedules.sort((a, b) => a.startAt.localeCompare(b.startAt));
  writeScheduleFile(file);
  return next;
}

export function deleteLocalSchedule(id: string): boolean {
  const file = readScheduleFile();
  const next = file.schedules.filter((item) => item.id !== id);
  if (next.length === file.schedules.length) return false;
  writeScheduleFile({ version: 1, schedules: next });
  return true;
}

function dateKeyInTimezone(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function listLocalSchedules(date?: string, timezone?: string): LocalScheduleItem[] {
  const schedules = readScheduleFile().schedules;
  if (!date) return [...schedules];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期必须是 YYYY-MM-DD');
  const tz = timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  // 先触发一次构造，确保无效 IANA 时区明确报错，而非悄悄使用本机时区。
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  return schedules.filter((item) => dateKeyInTimezone(item.startAt, tz) === date);
}

export function subscribeLocalSchedules(listener: (items: LocalScheduleItem[]) => void): () => void {
  scheduleEvents.on('changed', listener);
  return () => scheduleEvents.off('changed', listener);
}

export type LocalScheduleToolParams =
  | {
      action: 'create';
      title: string;
      startAt: string;
      endAt?: string;
      notes?: string;
      reason?: string;
    }
  | { action: 'list'; date?: string; timezone?: string }
  | {
      action: 'update';
      id: string;
      title?: string;
      startAt?: string;
      endAt?: string;
      notes?: string;
      reason?: string;
    }
  | { action: 'delete'; id: string };

/** Otto 可主动调用的本地日程工具。所有创建项都标记 source=otto。 */
export class LocalScheduleTool extends BaseTool<LocalScheduleToolParams, ToolResult> {
  static readonly Name = 'local_schedule';

  // Config 保留为构造契约，以便统一注册；存储本身不依赖它。
  constructor(_config: Config) {
    super(
      LocalScheduleTool.Name,
      'LocalSchedule',
      'Manage Otto local schedules. Use create after the user asks for a schedule, or when a completed work result has an explicit follow-up time. Include a concise reason when Otto creates one autonomously. Use list before moving or deleting an existing event. Dates must be ISO 8601. This is the same local calendar shown in the desktop work-log date view.',
      Icon.Tasks,
      {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, enum: ['create', 'list', 'update', 'delete'] },
          id: { type: Type.STRING },
          title: { type: Type.STRING },
          startAt: { type: Type.STRING },
          endAt: { type: Type.STRING },
          date: { type: Type.STRING },
          timezone: { type: Type.STRING },
          notes: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['action'],
      },
    );
  }

  validateToolParams(params: LocalScheduleToolParams): string | null {
    const schemaError = SchemaValidator.validate(
      this.schema.parameters,
      params,
      LocalScheduleTool.Name,
    );
    if (schemaError) return schemaError;
    if (params.action === 'create') {
      if (!('title' in params) || !params.title?.trim()) return 'create 需要非空 title';
      if (!('startAt' in params) || !params.startAt?.trim()) return 'create 需要 startAt';
      try {
        validateTimeRange(params.startAt, params.endAt);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    if ((params.action === 'update' || params.action === 'delete') && !('id' in params && params.id?.trim())) {
      return `${params.action} 需要非空 id`;
    }
    if (params.action === 'list' && params.date && !/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
      return 'date 必须是 YYYY-MM-DD';
    }
    return null;
  }

  getDescription(params: LocalScheduleToolParams): string {
    if (params.action === 'create') return `创建日程：${params.title}`;
    if (params.action === 'list') return `查看日程：${params.date || '全部'}`;
    return `${params.action === 'update' ? '更新' : '删除'}日程：${params.id}`;
  }

  async execute(params: LocalScheduleToolParams, _signal: AbortSignal): Promise<ToolResult> {
    const error = this.validateToolParams(params);
    if (error) return { llmContent: `local_schedule FAIL: ${error}`, returnDisplay: `日程操作失败：${error}` };
    try {
      let result: LocalScheduleItem | LocalScheduleItem[] | { deleted: boolean; id: string };
      if (params.action === 'create') {
        result = createLocalSchedule({
          title: params.title,
          startAt: params.startAt,
          endAt: params.endAt,
          notes: params.notes,
          reason: params.reason,
          source: 'otto',
        });
      } else if (params.action === 'list') {
        result = listLocalSchedules(params.date, params.timezone);
      } else if (params.action === 'update') {
        result = updateLocalSchedule(params.id, {
          title: params.title,
          startAt: params.startAt,
          endAt: params.endAt,
          notes: params.notes,
          reason: params.reason,
        });
      } else {
        result = { deleted: deleteLocalSchedule(params.id), id: params.id };
      }
      const json = JSON.stringify(result);
      return {
        llmContent: json,
        returnDisplay:
          params.action === 'list'
            ? `已读取 ${Array.isArray(result) ? result.length : 0} 条日程`
            : `日程已${params.action === 'create' ? '创建' : params.action === 'update' ? '更新' : '删除'}`,
        summary: this.getDescription(params),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { llmContent: `local_schedule FAIL: ${message}`, returnDisplay: `日程操作失败：${message}` };
    }
  }
}
