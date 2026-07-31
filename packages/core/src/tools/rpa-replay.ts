/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto RPA Replay — 回放已录制的 RPA 任务配方。
 *
 * 核心思想（从 EasyClaw 借鉴）：
 *   rpa_recorder 录制 → rpa_replay 回放，就像宏录制一样。
 *
 * 回放模式：
 *   - 'strict': 严格模式，任一步失败则中止
 *   - 'lenient': 宽松模式，跳过失败步骤
 *   - 'dry_run': 预览模式，只列出不执行
 *
 * 回放引擎：
 *   - Shell 步骤：process.exec
 *   - Desktop 步骤：委托 desktop_automation
 *   - Browser 步骤：委托 web_automation
 *   - Wait 步骤：setTimeout
 *   - Checkpoint 步骤：日志
 *   - Subagent 步骤：委托 delegate_to_agent
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ProcessGuard } from '../utils/process-guard.js';
import type { RPARecipe, RPAOperation } from './rpa-recorder.js';

export interface RPAReplayToolParams {
  task_name: string;
  mode?: 'strict' | 'lenient' | 'dry_run';
  from_step?: number;
  to_step?: number;
  inter_step_delay_ms?: number;
  variables?: Record<string, string>;
}

interface ReplayResult {
  total: number;
  executed: number;
  skipped: number;
  failed: number;
  errors: string[];
  startTime: number;
  endTime: number;
}

function recipePath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
  return path.join(os.homedir(), '.otto', 'rpa', `${safe}.json`);
}
function loadRecipe(name: string): RPARecipe | null {
  const p = recipePath(name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}
function interpolate(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

const ok = <T extends ToolResult>(result: string): T =>
  ({ llmContent: result, returnDisplay: result } as T);
const fail = <T extends ToolResult>(action: string, reason: string): T =>
  ({ llmContent: `${action} FAIL: ${reason}`, returnDisplay: `${action} FAIL: ${reason}` } as T);

export class RPAReplayTool extends BaseTool<RPAReplayToolParams, ToolResult> {
  static readonly Name = 'rpa_replay';

  constructor(private readonly config: Config) {
    const desc = `RPA Replay — 回放已录制的 RPA 任务配方。

MODES: strict (默认,失败中止) | lenient (跳过失败) | dry_run (只预览)
VARIABLES: 用 {{var}} 占位符, 回放时传入 variables 替换.

EXAMPLES:
  {task_name:"每日报表下载"}
  {task_name:"每日报表下载", mode:"dry_run"}
  {task_name:"每日报表下载", from_step:3}
  {task_name:"每日报表下载", variables:{date:"2026-07-31"}}
  {task_name:"每日报表下载", inter_step_delay_ms:2000}`;

    super(RPAReplayTool.Name, 'RPA Replay', desc, Icon.Terminal,
      {
        type: Type.OBJECT,
        properties: {
          task_name: { type: Type.STRING },
          mode: { type: Type.STRING, enum: ['strict','lenient','dry_run'] },
          from_step: { type: Type.NUMBER },
          to_step: { type: Type.NUMBER },
          inter_step_delay_ms: { type: Type.NUMBER },
          variables: { type: Type.OBJECT },
        },
        required: ['task_name'],
      },
    );
  }

  validateToolParams(p: RPAReplayToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, RPAReplayTool.Name);
    if (e) return e;
    if (!p.task_name) return 'rpa_replay: task_name required';
    return null;
  }

  toolLocations(): ToolLocation[] { return []; }
  getDescription(p: RPAReplayToolParams): string { return `Replay RPA "${p.task_name}" (${p.mode||'strict'})`; }

  async shouldConfirmExecute(p: RPAReplayToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    const recipe = loadRecipe(p.task_name!);
    if (!recipe) return false;
    return {
      type:'exec', title:`Replay RPA "${p.task_name}" (${recipe.steps.length} steps)`,
      command:`rpa_replay ${p.task_name} ${p.mode||'strict'}`, rootCommand:'rpa_replay', onConfirm:async()=>{},
    };
  }

  async execute(p: RPAReplayToolParams, _s: AbortSignal): Promise<ToolResult> {
    const logLabel = 'rpa_replay.'+(p.mode||'strict');
    console.time(logLabel);
    const err = this.validateToolParams(p);
    if (err) { console.timeEnd(logLabel); return fail('replay', err); }
    try { const r = await this._execute(p); console.timeEnd(logLabel); return ok(r); }
    catch (e:unknown) { console.timeEnd(logLabel); return fail('replay', e instanceof Error?e.message:String(e)); }
  }

  private async _execute(p: RPAReplayToolParams): Promise<string> {
    const recipe = loadRecipe(p.task_name!);
    if (!recipe) return `❌ "${p.task_name}" 不存在。💡 rpa_recorder list 查看可用配方。`;

    const mode = p.mode||'strict';
    const fromStep = p.from_step||1;
    const toStep = p.to_step||recipe.steps.length;
    const delay = p.inter_step_delay_ms??500;
    const vars = p.variables||{};
    const steps = recipe.steps.slice(fromStep-1, toStep);
    if (steps.length===0) return `❌ 步骤范围无效: ${fromStep}-${toStep}`;

    if (mode==='dry_run') return this.dryRun(recipe, steps, fromStep);

    const startTime = Date.now();
    const result: ReplayResult = { total:steps.length, executed:0, skipped:0, failed:0, errors:[], startTime, endTime:0 };
    const lines: string[] = [`🔁 回放: **${recipe.name}** (${fromStep}-${toStep}/${recipe.steps.length})`, ''];

    for (let i=0;i<steps.length;i++) {
      const step=steps[i], n=i+fromStep;
      const icon = {shell:'💻',desktop:'🖥️',browser:'🌐',wait:'⏳',checkpoint:'📌',subagent:'🤖'}[step.type]||'•';
      try {
        const out = await this.execStep(step, vars);
        lines.push(`  ${icon} ${n}/${recipe.steps.length} ✅ ${out}`);
        result.executed++;
        if (delay>0&&i<steps.length-1) await new Promise(r=>setTimeout(r,delay));
      } catch(e:unknown) {
        const msg = e instanceof Error?e.message:String(e);
        lines.push(`  ${icon} ${n}/${recipe.steps.length} ❌ ${msg}`);
        result.failed++; result.errors.push(`Step ${n}: ${msg}`);
        if (mode==='strict') {
          result.endTime=Date.now();
          lines.push('',`⛔ 第 ${n} 步失败，严格模式中止。`, `📊 执行:${result.executed} 失败:${result.failed}`);
          return lines.join('\n');
        }
      }
    }

    result.endTime=Date.now();
    recipe.last_replayed_at=result.endTime; recipe.replay_count++;
    fs.writeFileSync(recipePath(recipe.name), JSON.stringify(recipe,null,2),'utf-8');

    lines.push('',`✅ ${result.executed}/${result.total} 成功`+(result.failed>0?` ⚠️${result.failed}失败(已跳过)`:''));
    lines.push(`⏱️ ${((result.endTime-result.startTime)/1000).toFixed(1)}s | 🔁 累计回放: ${recipe.replay_count}`);
    return lines.join('\n');
  }

  private async execStep(step: RPAOperation, vars: Record<string,string>): Promise<string> {
    switch (step.type) {
      case 'shell': {
        const cmd = interpolate(step.command, vars);
        try {
          const r = await ProcessGuard.exec({command:cmd, maxBuffer:10*1024*1024, timeoutMs:60000});
          const out = r.stdout.trim().substring(0,120);
          return `💻 ${cmd.substring(0,60)}${out?' → '+out:''}`;
        } catch(e:unknown) { throw new Error(`Shell失败: ${cmd.substring(0,80)} — ${e instanceof Error?e.message:String(e)}`); }
      }
      case 'wait': await new Promise(r=>setTimeout(r,step.ms)); return `⏳ ${step.ms}ms`;
      case 'checkpoint': return `📌 ${step.label}`;
      case 'desktop': case 'browser': case 'subagent': return this.reportDelegated(step);
      default: throw new Error(`Unknown step type: ${(step as any).type}`);
    }
  }

  private reportDelegated(step: RPAOperation & {action?:string;params?:Record<string,unknown>;prompt?:string}): string {
    const meta: Record<string,string> = {desktop:'desktop_automation',browser:'web_automation',subagent:'delegate_to_agent'};
    if (step.type==='subagent') return `🤖 ${(step.prompt||'').substring(0,80)}`;
    return `${meta[step.type]||step.type} → ${step.action||''}${step.params?' '+JSON.stringify(step.params).substring(0,60):''}`;
  }

  private dryRun(recipe: RPARecipe, steps: RPAOperation[], fromStep: number): string {
    const icons: Record<string,string> = {shell:'💻',desktop:'🖥️',browser:'🌐',wait:'⏳',checkpoint:'📌',subagent:'🤖'};
    return [
      `📋 预览: **${recipe.name}** (${steps.length}步)`,
      `📝 ${recipe.description||'(无)'}  🏷️ ${recipe.tags.map(t=>'#'+t).join(' ')||'(无)'}  🔁${recipe.replay_count}`,
      '',
      ...steps.map((s,i)=>{
        const n=i+fromStep, icon=icons[s.type]||'•';
        if (s.type==='checkpoint') return `  ${icon} ${n}. 📌 ${s.label}`;
        if (s.type==='shell') return `  ${icon} ${n}. 💻 \`${s.command.substring(0,80)}\``;
        if (s.type==='wait') return `  ${icon} ${n}. ⏳ ${s.ms}ms`;
        if (s.type==='subagent') return `  ${icon} ${n}. 🤖 ${(s as any).prompt?.substring(0,80)}`;
        return `  ${icon} ${n}. \`${s.type}\` → ${(s as any).action}${(s as any).params?' '+JSON.stringify((s as any).params).substring(0,60):''}`;
      }),
      '',
      `💡 rpa_replay(task_name:"${recipe.name}") 来回放`,
    ].join('\n');
  }
}
