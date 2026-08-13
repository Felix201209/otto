import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import { Type } from '@google/genai';
import { BaseTool, Icon, type ToolLocation, type ToolResult } from './tools.js';
import { MultiChannelGateway } from '../a2a/multi-channels.js';

export interface ActionItem { id?: string; task: string; assignee: string; assignee_openid?: string; due: string; status?: 'open'|'doing'|'done'; source_meeting?: string }
interface Store { version: number; processedMeetings: unknown[]; actionItems: Required<Pick<ActionItem,'id'|'task'|'assignee'|'due'|'status'|'source_meeting'>>[] & ActionItem[] }
export function meetingActionStorePath() { return process.env.OTTO_MEETING_ACTIONS_FILE?.trim() || path.join(process.env.OTTO_USER_DIR?.trim() || path.join(os.homedir(), '.otto-user'), 'meeting-actions.json'); }
async function load(file: string): Promise<Store> { try { const value = JSON.parse(await readFile(file, 'utf8')); return { version: 1, processedMeetings: Array.isArray(value.processedMeetings) ? value.processedMeetings : [], actionItems: Array.isArray(value.actionItems) ? value.actionItems : [] }; } catch { return { version: 1, processedMeetings: [], actionItems: [] }; } }
export async function registerMeetingActions(file: string, source: string, items: ActionItem[]) {
  if (!source.trim() || items.length === 0) throw new Error('会议来源和行动项不能为空');
  const store = await load(file); const ids = new Set(store.actionItems.map((x) => x.id));
  const added = items.map((item) => { if (!item.task.trim() || !item.assignee.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(item.due)) throw new Error('行动项必须包含 task、assignee 和 YYYY-MM-DD due'); let id = item.id || `AI-${randomUUID().slice(0, 8)}`; if (ids.has(id)) id = `AI-${randomUUID().slice(0, 8)}`; ids.add(id); return { ...item, id, status: item.status || 'open', source_meeting: source }; });
  store.actionItems.push(...added as Store['actionItems']); await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.tmp`; await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, file); return added;
}
export async function dueMeetingActions(file: string, today: string) { return (await load(file)).actionItems.filter((x) => (x.status === 'open' || x.status === 'doing') && x.due <= today); }

interface Params { action: 'register'|'remind'; source_meeting?: string; summary?: string; action_items?: ActionItem[]; today?: string }
export class MeetingActionsTool extends BaseTool<Params, ToolResult> {
  static readonly Name = 'meeting_actions';
  constructor() { super(MeetingActionsTool.Name, 'Meeting Actions', '一键会议落地：先按 meeting-notes skill（录音先用 audio_reader）产出结构化纪要，再登记行动项；remind 发送今日到期待办。', Icon.Terminal, { type: Type.OBJECT, properties: { action: { type: Type.STRING, enum: ['register','remind'] }, source_meeting: { type: Type.STRING }, summary: { type: Type.STRING }, action_items: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { task: { type: Type.STRING }, assignee: { type: Type.STRING }, assignee_openid: { type: Type.STRING }, due: { type: Type.STRING }, status: { type: Type.STRING } }, required: ['task','assignee','due'] } }, today: { type: Type.STRING } }, required: ['action'] }); }
  validateToolParams() { return null; } toolLocations(): ToolLocation[] { return []; } getDescription(p: Params) { return `meeting_actions ${p.action}`; } async shouldConfirmExecute() { return false as const; }
  async execute(p: Params): Promise<ToolResult> { try { const file = meetingActionStorePath(); if (p.action === 'register') { const added = await registerMeetingActions(file, p.source_meeting || '', p.action_items || []); const text = `已登记 ${added.length} 个行动项到 ${file}`; return { llmContent: `${p.summary || ''}\n${text}`, returnDisplay: text }; } const today = p.today || new Date().toISOString().slice(0,10); const due = await dueMeetingActions(file, today); if (!due.length) return { llmContent: '今日无到期待办', returnDisplay: '今日无到期待办' }; const body = due.map((x) => `- ${x.task} | ${x.assignee} | ${x.due} | ${x.status}`).join('\n'); const sent = await new MultiChannelGateway().broadcastUpdate(`Otto 待办提醒 ${today}`, body); const delivered = Object.entries(sent).filter(([,ok]) => ok).map(([x]) => x); if (!delivered.length) throw new Error('待办已扫描，但未成功送达任何已配置渠道'); return { llmContent: `已提醒 ${due.length} 项：${delivered.join(', ')}`, returnDisplay: `已提醒 ${due.length} 项` }; } catch (error) { const text = `meeting_actions FAIL: ${(error as Error).message}`; return { llmContent: text, returnDisplay: text }; } }
}
