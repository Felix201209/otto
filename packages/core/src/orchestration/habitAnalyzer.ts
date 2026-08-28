/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * HabitAnalyzer — 内置大模型习惯分析引擎
 *
 * 与 RealtimeWatcher 的区别：
 * - Watcher 只看「做了几次同类操作」（机械匹配）
 * - HabitAnalyzer 用 LLM 理解「为什么这样做、在什么时段做、形成了什么工作流模式」
 *
 * 后台静默积累操作日志，定期调 LLM 做深度分析，产出结构化洞察。
 */

import type { Config } from '../config/config.js';
import { SceneType, SceneManager } from '../core/sceneManager.js';
import { getResponseText } from '../utils/partUtils.js';
import {
  RecurringTaskRegistry,
} from '../services/recurringTaskRegistry.js';

/** 习惯分析结果 */
export interface HabitInsight {
  id: string;
  type: 'workflow' | 'bottleneck' | 'suggestion' | 'peak_hour' | 'tool_chain' | 'summary';
  title: string;
  description: string;
  evidence: string[];
  action?: string;
  priority: number;
  confidence: number;
  timestamp: string;
}

/** 单条操作记录 */
export interface OperationRecord {
  action: string;
  category: string;
  success: boolean;
  durationMs?: number;
  details?: string;
  timestamp: string;
  toolName: string;
}

export class HabitAnalyzer {
  private readonly ops: OperationRecord[] = [];
  private readonly maxOps: number;
  private readonly analysisIntervalMs: number;
  private backgroundModelCallsEnabled: boolean;
  private readonly taskRegistry: RecurringTaskRegistry;
  private stopScheduledAnalysis: (() => void) | undefined;
  private onInsights?: (insights: HabitInsight[]) => void;
  private analysisInFlight = false;
  private config: Config | null = null;

  constructor(opts: {
    maxOps?: number;
    analysisIntervalMs?: number;
    /** Explicit user opt-in; false by default, including personal installs. */
    backgroundModelCallsEnabled?: boolean;
    taskRegistry?: RecurringTaskRegistry;
  } = {}) {
    this.maxOps = opts.maxOps ?? 2000;
    this.analysisIntervalMs = opts.analysisIntervalMs ?? 2 * 60 * 60 * 1000;
    this.backgroundModelCallsEnabled = opts.backgroundModelCallsEnabled === true;
    // This private registry can schedule paid work, but start() remains behind
    // the explicit preference gate above. The exported shared registry stays
    // fail-closed for all other callers.
    this.taskRegistry = opts.taskRegistry
      ?? new RecurringTaskRegistry({ allowPaidBackground: true });
  }

  setConfig(config: Config): void { this.config = config; }
  setCallback(cb: (insights: HabitInsight[]) => void): void { this.onInsights = cb; }

  feed(op: OperationRecord): void {
    this.ops.push(op);
    if (this.ops.length > this.maxOps) {
      this.ops.splice(0, this.ops.length - this.maxOps);
    }
  }

  start(): boolean {
    if (this.stopScheduledAnalysis) return false;
    if (!this.backgroundModelCallsEnabled) return false;
    this.stopScheduledAnalysis = this.taskRegistry.register({
      name: 'habit-analyzer-model-analysis',
      source: 'packages/core/src/orchestration/habitAnalyzer.ts',
      intervalMs: this.analysisIntervalMs,
      initialDelayMs: 10 * 60 * 1000,
      estimatedCostUsdPerRun: 0.01,
      getInputVersion: () => {
        const last = this.ops[this.ops.length - 1];
        return last ? `${this.ops.length}:${last.timestamp}` : undefined;
      },
      run: async () => {
        await this.runAnalysis();
      },
    });
    return this.stopScheduledAnalysis !== undefined;
  }

  stop(): void {
    this.stopScheduledAnalysis?.();
    this.stopScheduledAnalysis = undefined;
  }

  /** Apply an explicit user preference at runtime; omitted/false stays inert. */
  setBackgroundModelCallsEnabled(enabled: boolean): void {
    const next = enabled === true;
    if (next === this.backgroundModelCallsEnabled) return;
    this.stop();
    this.backgroundModelCallsEnabled = next;
    if (next) this.start();
  }

  async runAnalysis(): Promise<HabitInsight[]> {
    if (this.analysisInFlight) return [];
    if (this.ops.length < 20) return [];
    this.analysisInFlight = true;
    try {
      const insights = this.config ? await this.llmAnalyze(this.config) : this.basicAnalyze();
      if (insights.length > 0) this.onInsights?.(insights);
      return insights;
    } catch (err) {
      console.warn('[HabitAnalyzer] LLM failed, using basic:', (err as Error)?.message);
      return this.basicAnalyze();
    } finally {
      this.analysisInFlight = false;
    }
  }

  private basicAnalyze(): HabitInsight[] {
    const insights: HabitInsight[] = [];
    const now = new Date().toISOString();

    const hourCounts: Record<number, number> = {};
    for (const op of this.ops) {
      const h = new Date(op.timestamp).getHours();
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    }
    const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
    if (peakHour) {
      insights.push({
        id: 'peak-' + Date.now(), type: 'peak_hour',
        title: '高峰时段', description: '操作集中在 ' + peakHour[0] + ':00（' + peakHour[1] + ' 次）。',
        evidence: [peakHour[0] + ':00: ' + peakHour[1] + ' 次'],
        priority: 60, confidence: 0.95, timestamp: now,
      });
    }

    const chains = this.buildToolChains();
    if (chains.length > 0) {
      const c = chains[0];
      insights.push({
        id: 'chain-' + Date.now(), type: 'tool_chain',
        title: '常用工具链', description: c.before + ' → ' + c.after + ' 出现 ' + c.count + ' 次。',
        evidence: [c.before + ' → ' + c.after + ' x' + c.count],
        priority: 70, confidence: 0.85, timestamp: now,
      });
    }

    const total = this.ops.length;
    const failRate = 1 - this.ops.filter((o) => o.success).length / total;
    if (failRate > 0.15) {
      const fails = this.ops.filter((o) => !o.success);
      insights.push({
        id: 'bottleneck-' + Date.now(), type: 'bottleneck',
        title: '效率瓶颈', description: '失败率 ' + Math.round(failRate * 100) + '% (' + fails.length + '/' + total + ')。',
        evidence: fails.slice(0, 5).map((o) => o.action + (o.details ? ': ' + o.details : '')),
        action: '建议回顾失败操作并优化流程。', priority: 75, confidence: 0.90, timestamp: now,
      });
    }

    return insights;
  }

  private async llmAnalyze(config: Config): Promise<HabitInsight[]> {
    const client = config.getOttoClient();
    if (!client) return this.basicAnalyze();

    const recentOps = this.ops.slice(-300);
    const today = new Date().toISOString().split('T')[0];

    const slotMap: Record<string, string[]> = {};
    for (const op of recentOps) {
      const h = new Date(op.timestamp).getHours();
      const slot = h < 6 ? '凌晨' : h < 9 ? '清晨' : h < 12 ? '上午' : h < 14 ? '午间' : h < 18 ? '下午' : h < 22 ? '晚上' : '深夜';
      if (!slotMap[slot]) slotMap[slot] = [];
      slotMap[slot].push(op.action);
    }

    const catGroups: Record<string, number> = {};
    for (const op of recentOps) {
      catGroups[op.category] = (catGroups[op.category] || 0) + 1;
    }

    const chains = this.buildToolChains();

    const lines = [
      '你是洞察力极强的工作习惯分析师。以下是用户的操作数据，做深度语义分析：',
      '',
      '总操作: ' + recentOps.length + ' | 成功率: ' + Math.round(recentOps.filter((o) => o.success).length / recentOps.length * 100) + '% | 日期: ' + today,
    ];

    for (const [slot, acts] of Object.entries(slotMap)) {
      const uniq = [...new Set(acts)];
      lines.push(slot + ': ' + acts.length + '次, 主要: ' + uniq.slice(0, 3).join('、'));
    }

    lines.push('');
    for (const [cat, cnt] of Object.entries(catGroups).sort((a, b) => b[1] - a[1])) {
      lines.push(cat + ': ' + cnt + '次');
    }

    lines.push('');
    for (const c of chains.slice(0, 5)) {
      lines.push(c.before + ' → ' + c.after + ' (' + c.count + '次)');
    }

    lines.push('');
    const latestOps = recentOps.slice(-30);
    for (const op of latestOps) {
      const t = new Date(op.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const mark = op.success ? 'OK' : 'FAIL';
      lines.push('[' + t + '] ' + mark + ' ' + op.action + (op.details ? ' | ' + op.details.slice(0, 80) : ''));
    }

    lines.push('');
    lines.push('基于数据给出3-6条洞察（JSON）。type可选: workflow/bottleneck/suggestion/peak_hour/tool_chain/summary');
    lines.push('只输出JSON，用中文。格式: {"insights":[{"type":"...","title":"...","description":"...","evidence":["..."],"action":"...","priority":80,"confidence":0.9}]}');

    const prompt = lines.join('\n');

    const chat = await client.createTemporaryChat(
      SceneType.CHAT_CONVERSATION,
      SceneManager.getModelForScene(SceneType.CHAT_CONVERSATION),
      { type: 'sub', agentId: 'HabitAnalyzer' },
      { emptySystemPrompt: true },
    );
    const response = await chat.sendMessage(
      { message: prompt, config: { maxOutputTokens: 8192 } },
      'habit-' + Date.now(), SceneType.CHAT_CONVERSATION,
    );

    const raw = getResponseText(response);
    if (!raw) return this.basicAnalyze();

    const text = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed: { insights?: Array<Partial<HabitInsight>> };
    try {
      parsed = JSON.parse(text);
    } catch {
      const fb = text.indexOf('{');
      const lb = text.lastIndexOf('}');
      if (fb < 0) return this.basicAnalyze();
      parsed = JSON.parse(text.slice(fb, lb + 1));
    }

    if (!Array.isArray(parsed.insights)) return this.basicAnalyze();

    const now = new Date().toISOString();
    return parsed.insights.slice(0, 6).map((item, i) => ({
      id: 'habit-' + Date.now() + '-' + i,
      type: item.type || 'suggestion',
      title: item.title || '习惯洞察',
      description: item.description || '',
      evidence: Array.isArray(item.evidence) ? item.evidence : [],
      action: item.action,
      priority: typeof item.priority === 'number' ? item.priority : 50,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
      timestamp: now,
    }));
  }

  private buildToolChains(): Array<{ before: string; after: string; count: number }> {
    const map = new Map<string, number>();
    for (let i = 0; i < this.ops.length - 1; i++) {
      const a = (this.ops[i].action.split(':')[0] || '').trim() || this.ops[i].action;
      const b = (this.ops[i + 1].action.split(':')[0] || '').trim() || this.ops[i + 1].action;
      if (a === b) continue;
      map.set(a + '|||' + b, (map.get(a + '|||' + b) || 0) + 1);
    }
    return [...map.entries()]
      .filter(([, c]) => c >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, c]) => {
        const [before, after] = k.split('|||');
        return { before, after, count: c };
      });
  }
}

let globalHabitAnalyzer: HabitAnalyzer | null = null;
export function getHabitAnalyzer(): HabitAnalyzer {
  if (!globalHabitAnalyzer) globalHabitAnalyzer = new HabitAnalyzer();
  return globalHabitAnalyzer;
}
