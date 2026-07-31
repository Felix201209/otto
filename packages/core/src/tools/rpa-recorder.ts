/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto RPA Recorder — 录制用户操作并固化为可复用的自动化任务。
 *
 * 核心思想（从 EasyClaw 借鉴）：
 *   用户说"帮我做X" → Otto 执行 → 自动录制操作序列 → 下次说"再做一次上次那个"直接回放。
 *
 * 录制内容：
 *   - Shell 命令序列（时间戳 + 命令 + exit code + stdout/stderr）
 *   - 桌面操作序列（launch_app, keyboard, mouse, screenshot 等）
 *   - 浏览器操作序列（navigate, fill, click, scrape 等）
 *   - workflow 编排脚本（跨步骤编排）
 *
 * 存储：.otto/rpa/<task-name>.json — 每步都是可回放的独立操作单元。
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

// ===== Types =====

export type RPAOperation =
  | { type: 'shell'; command: string; exitCode?: number; stdout?: string; stderr?: string; ts: number }
  | { type: 'desktop'; action: string; params: Record<string, unknown>; ts: number }
  | { type: 'browser'; action: string; params: Record<string, unknown>; ts: number }
  | { type: 'wait'; ms: number; ts: number }
  | { type: 'checkpoint'; label: string; ts: number }
  | { type: 'subagent'; prompt: string; result?: string; max_turns?: number; ts: number };

export interface RPARecipe {
  name: string;
  version: 1;
  created_at: number;
  last_replayed_at?: number;
  replay_count: number;
  description: string;
  tags: string[];
  steps: RPAOperation[];
  meta: {
    platform: string;
    osRelease: string;
  };
}

export interface RPARecorderToolParams {
  action: 'start' | 'step' | 'stop' | 'list' | 'delete' | 'export';
  task_name?: string;
  description?: string;
  tags?: string;
  step?: {
    type: RPAOperation['type'];
    action?: string;
    params?: Record<string, unknown>;
    command?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    ms?: number;
    label?: string;
    prompt?: string;
    result?: string;
    max_turns?: number;
  };
  export_format?: 'json' | 'markdown' | 'shell';
}

function rpaDir(): string {
  const dir = path.join(os.homedir(), '.otto', 'rpa');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function recipePath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
  return path.join(rpaDir(), `${safe}.json`);
}

function ok<T extends ToolResult>(result: string): T {
  return { llmContent: result, returnDisplay: result } as T;
}
function fail<T extends ToolResult>(action: string, reason: string): T {
  return { llmContent: `${action} FAIL: ${reason}`, returnDisplay: `${action} FAIL: ${reason}` } as T;
}

function acquireRecorderLock(taskName: string): boolean {
  const lockPath = path.join(rpaDir(), '.lock');
  if (fs.existsSync(lockPath)) {
    const owner = fs.readFileSync(lockPath, 'utf-8').trim();
    if (owner !== taskName) return false;
  }
  fs.writeFileSync(lockPath, taskName);
  return true;
}
function releaseRecorderLock(): void {
  const lockPath = path.join(rpaDir(), '.lock');
  try { fs.unlinkSync(lockPath); } catch {}
}

export class RPArecorderTool extends BaseTool<RPARecorderToolParams, ToolResult> {
  static readonly Name = 'rpa_recorder';

  private recording: RPARecipe | null = null;

  constructor(private readonly config: Config) {
    const desc = `RPA Recorder — 录制用户操作序列并固化为可复用的自动化任务。

ACTIONS:
  start  — 开始录制新任务
  step   — 追加一个操作步骤到录制中
  stop   — 停止录制并保存为可回放的任务配方
  list   — 列出所有已保存的任务配方
  delete — 删除指定任务配方
  export — 导出任务配方为 JSON/Markdown/Shell 脚本

EXAMPLES:
  Start: {action:"start", task_name:"每日报表下载", description:"打开OA→登录→下载销售报表→保存到桌面", tags:"报表,OA,每日"}
  Step:  {action:"step", task_name:"每日报表下载", step:{type:"browser", action:"navigate", params:{url:"https://oa.company.com/login"}}}
  Shell: {action:"step", task_name:"每日报表下载", step:{type:"shell", command:"ls ~/Desktop/*.xlsx"}}
  Wait:  {action:"step", task_name:"每日报表下载", step:{type:"wait", ms:2000}}
  Stop:  {action:"stop", task_name:"每日报表下载"}
  List:  {action:"list"}
  Del:   {action:"delete", task_name:"每日报表下载"}
  Export:{action:"export", task_name:"每日报表下载", export_format:"shell"}`;

    super(RPARecorderTool.Name, 'RPA Recorder', desc, Icon.Terminal,
      {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, enum: ['start','step','stop','list','delete','export'], description: 'What to do' },
          task_name: { type: Type.STRING, description: 'Task/recipe name. Required for all actions except list.' },
          description: { type: Type.STRING, description: 'Human-readable description' },
          tags: { type: Type.STRING, description: 'Comma-separated tags (e.g. "报表,OA,每日")' },
          step: {
            type: Type.OBJECT,
            properties: {
              type: { type: Type.STRING, enum: ['shell','desktop','browser','wait','checkpoint','subagent'] },
              action: { type: Type.STRING },
              params: { type: Type.OBJECT },
              command: { type: Type.STRING },
              exitCode: { type: Type.NUMBER },
              stdout: { type: Type.STRING },
              stderr: { type: Type.STRING },
              ms: { type: Type.NUMBER },
              label: { type: Type.STRING },
              prompt: { type: Type.STRING },
              result: { type: Type.STRING },
              max_turns: { type: Type.NUMBER },
            },
          },
          export_format: { type: Type.STRING, enum: ['json','markdown','shell'] },
        },
        required: ['action'],
      },
    );
  }

  validateToolParams(p: RPARecorderToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, RPARecorderTool.Name);
    if (e) return e;
    if (p.action !== 'list' && !p.task_name) return 'rpa_recorder: task_name required';
    if (p.action === 'step' && !p.step) return 'rpa_recorder/step: step required';
    if (p.action === 'step' && p.step && !p.step.type) return 'rpa_recorder/step: step.type required';
    return null;
  }

  toolLocations(): ToolLocation[] { return []; }

  getDescription(p: RPARecorderToolParams): string {
    if (p.action === 'list') return 'List all RPA recipes';
    if (p.action === 'export') return `Export RPA "${p.task_name}" as ${p.export_format||'json'}`;
    return `RPA ${p.action}: ${p.task_name||''}`;
  }

  async shouldConfirmExecute(p: RPARecorderToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (this.config.getApprovalMode() === ApprovalMode.YOLO) return false;
    if (p.action === 'delete') {
      return { type:'exec', title:'Delete RPA "'+p.task_name+'"', command:`rpa_recorder delete ${p.task_name}`, rootCommand:'rpa_recorder', onConfirm:async()=>{} };
    }
    return false;
  }

  async execute(p: RPARecorderToolParams, _s: AbortSignal): Promise<ToolResult> {
    const logLabel = 'rpa_recorder.'+p.action;
    console.time(logLabel);
    const err = this.validateToolParams(p);
    if (err) { console.timeEnd(logLabel); return fail(p.action, err); }
    try {
      const r = await this._execute(p);
      console.timeEnd(logLabel);
      return ok(r);
    } catch (e: unknown) {
      console.timeEnd(logLabel);
      return fail(p.action, e instanceof Error ? e.message : String(e));
    }
  }

  private async _execute(p: RPARecorderToolParams): Promise<string> {
    switch (p.action) {
      case 'start': return this.startRecording(p.task_name!, p.description||'', p.tags||'');
      case 'step': return this.recordStep(p.task_name!, p.step!);
      case 'stop': return this.stopRecording(p.task_name!);
      case 'list': return this.listRecipes();
      case 'delete': return this.deleteRecipe(p.task_name!);
      case 'export': return this.exportRecipe(p.task_name!, p.export_format||'json');
      default: throw new Error('Unknown action: '+p.action);
    }
  }

  private startRecording(name: string, description: string, tags: string): string {
    if (!acquireRecorderLock(name)) return `⚠️ 录制冲突：任务 "${name}" 正在被另一个会话录制中。`;
    const existingPath = recipePath(name);
    const overwrite = fs.existsSync(existingPath) ? ' (覆盖已有配方)' : '';
    this.recording = {
      name, version:1, created_at:Date.now(), replay_count:0,
      description, tags: tags.split(',').map(t=>t.trim()).filter(Boolean),
      steps:[], meta:{ platform:os.platform(), osRelease:os.release() },
    };
    const tagList = this.recording.tags.length>0 ? this.recording.tags.map(t=>'#'+t).join(' ') : '(无标签)';
    return [
      `✅ 开始录制: "${name}"${overwrite}`,
      `📝 ${description||'(无描述)'}  🏷️ ${tagList}`,
      `💡 用 rpa_recorder step 追加每一步，完成后 rpa_recorder stop 保存。`,
    ].join('\n');
  }

  private recordStep(name: string, step: RPARecorderToolParams['step']): string {
    if (!this.recording || this.recording.name !== name) {
      const p = recipePath(name);
      if (fs.existsSync(p)) {
        this.recording = JSON.parse(fs.readFileSync(p,'utf-8'));
        if (!acquireRecorderLock(name)) return `⚠️ 录制冲突：任务 "${name}" 正在被另一个会话录制中。`;
      } else {
        return `❌ 没有在录制 "${name}"。先用 rpa_recorder start。`;
      }
    }
    if (!step) throw new Error('step required');
    const ts = Date.now();
    const op: RPAOperation = { ts } as RPAOperation;
    switch (step.type) {
      case 'shell':
        (op as any).type='shell'; (op as any).command=step.command||'';
        if (step.exitCode!==undefined) (op as any).exitCode=step.exitCode;
        if (step.stdout) (op as any).stdout=step.stdout;
        if (step.stderr) (op as any).stderr=step.stderr;
        break;
      case 'desktop': (op as any).type='desktop'; (op as any).action=step.action||''; (op as any).params=step.params||{}; break;
      case 'browser': (op as any).type='browser'; (op as any).action=step.action||''; (op as any).params=step.params||{}; break;
      case 'wait': (op as any).type='wait'; (op as any).ms=step.ms||1000; break;
      case 'checkpoint': (op as any).type='checkpoint'; (op as any).label=step.label||''; break;
      case 'subagent': (op as any).type='subagent'; (op as any).prompt=step.prompt||''; if(step.result) (op as any).result=step.result; if(step.max_turns) (op as any).max_turns=step.max_turns; break;
      default: throw new Error('Unknown step type: '+step.type);
    }
    this.recording.steps.push(op);
    const n = this.recording.steps.length;
    const icon: Record<string,string> = {shell:'💻',desktop:'🖥️',browser:'🌐',wait:'⏳',checkpoint:'📌',subagent:'🤖'};
    const summary = step.type==='checkpoint'?step.label||'checkpoint'
      :step.type==='wait'?`等待 ${step.ms}ms`
      :step.type==='shell'?(step.command||'').substring(0,60)
      :step.type==='subagent'?(step.prompt||'').substring(0,60)
      :`${step.action}(${JSON.stringify(step.params||{}).substring(0,40)})`;
    return `📝 第 ${n} 步 ${icon[step.type]||''} ${step.type}: ${summary}`;
  }

  private stopRecording(name: string): string {
    if (!this.recording || this.recording.name !== name) {
      const p = recipePath(name);
      if (fs.existsSync(p)) {
        const loaded = JSON.parse(fs.readFileSync(p,'utf-8')) as RPARecipe;
        releaseRecorderLock();
        return `⚠️ "${name}" 已在磁盘上 (${loaded.steps.length} 步, 回放 ${loaded.replay_count} 次)。💡 rpa_replay(task_name:"${name}") 来回放。`;
      }
      releaseRecorderLock();
      return `❌ 没有在录制 "${name}"。用 rpa_recorder start 开始。`;
    }
    const recipe = this.recording;
    fs.writeFileSync(recipePath(name), JSON.stringify(recipe,null,2), 'utf-8');
    releaseRecorderLock();
    this.recording = null;
    const icons: Record<string,string> = {shell:'💻',desktop:'🖥️',browser:'🌐',wait:'⏳',checkpoint:'📌',subagent:'🤖'};
    const summary = recipe.steps.map((s,i) =>
      `  ${i+1}. ${icons[s.type]||'•'} ${s.type==='checkpoint'?s.label:s.type==='shell'?s.command.substring(0,50):s.type==='subagent'?(s as any).prompt?.substring(0,50):(s as any).action||s.type}`).join('\n');
    return [
      `✅ 录制完成: "${name}" (${recipe.steps.length} 步)`,
      `📂 ${recipePath(name)}`,
      summary,
      `🔁 rpa_replay(task_name:"${name}") 来回放`,
    ].join('\n');
  }

  private listRecipes(): string {
    const dir = rpaDir();
    const files = fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
    if (files.length===0) return '📭 没有已保存的 RPA 配方。\n💡 用 rpa_recorder start 开始录制。';
    const recipes = files.map(f=>{try{return JSON.parse(fs.readFileSync(path.join(dir,f),'utf-8'))}catch{return null}}).filter(Boolean) as RPARecipe[];
    recipes.sort((a,b)=>(b.last_replayed_at||b.created_at)-(a.last_replayed_at||a.created_at));
    return `📋 已保存 ${recipes.length} 个 RPA 配方:\n\n`+recipes.map((r,i)=>{
      const lp = r.last_replayed_at?new Date(r.last_replayed_at).toLocaleString('zh-CN'):'从未回放';
      const tags = r.tags.length>0?r.tags.map(t=>'#'+t).join(' '):'';
      return `${i+1}. **${r.name}** (${r.steps.length}步) 🔁${r.replay_count}\n   📝 ${r.description||'(无)'}  ${tags}\n   🕐 ${new Date(r.created_at).toLocaleString('zh-CN')} | 最后: ${lp}`;
    }).join('\n\n');
  }

  private deleteRecipe(name: string): string {
    const p = recipePath(name);
    if (!fs.existsSync(p)) return `❌ 任务 "${name}" 不存在。`;
    fs.unlinkSync(p);
    return `🗑️ 已删除: "${name}"`;
  }

  private exportRecipe(name: string, format: 'json'|'markdown'|'shell'): string {
    const p = recipePath(name);
    if (!fs.existsSync(p)) return `❌ 任务 "${name}" 不存在。`;
    const recipe: RPARecipe = JSON.parse(fs.readFileSync(p,'utf-8'));
    switch (format) {
      case 'json': return `📄 JSON:\n\`\`\`json\n${JSON.stringify(recipe,null,2)}\n\`\`\``;
      case 'markdown': {
        const icons: Record<string,string> = {shell:'💻',desktop:'🖥️',browser:'🌐',wait:'⏳',checkpoint:'📌',subagent:'🤖'};
        const md = [
          `# 🎬 ${recipe.name}`, '',
          `- 描述: ${recipe.description||'(无)'}  标签: ${recipe.tags.map(t=>'#'+t).join(' ')||'(无)'}  回放: ${recipe.replay_count}次`,
          '', '## 操作序列', '',
          ...recipe.steps.map((s,i)=>{
            const lines = [`### ${i+1}. ${icons[s.type]||'•'} ${s.type}`];
            if (s.type==='checkpoint') lines.push(`📌 ${s.label}`);
            else if (s.type==='shell') { lines.push(`\`\`\`bash\n${s.command}\n\`\`\``); if(s.stdout) lines.push(`<details><summary>stdout</summary>\n\`\`\`\n${s.stdout}\n\`\`\`\n</details>`); }
            else if (s.type==='wait') lines.push(`⏳ ${s.ms}ms`);
            else if (s.type==='subagent') { lines.push(`> ${(s as any).prompt}`); if((s as any).result) lines.push(`<details><summary>结果</summary>\n\`\`\`\n${(s as any).result}\n\`\`\`\n</details>`); }
            else lines.push(`- \`${(s as any).action}\`  \`\`\`json\n${JSON.stringify((s as any).params||{},null,2)}\n\`\`\``);
            lines.push(''); return lines.join('\n');
          }),
        ];
        return `📄 Markdown:\n\n${md.join('\n')}`;
      }
      case 'shell': {
        const lines = ['#!/bin/bash',`# RPA: ${recipe.name}`, `# ${recipe.description}`, '', 'set -euo pipefail', ''];
        for (const s of recipe.steps) {
          if (s.type==='shell') { lines.push(`# ${s.command}`); lines.push(s.command); lines.push(''); }
          else if (s.type==='wait') { lines.push(`sleep ${(s.ms/1000).toFixed(1)}`); lines.push(''); }
          else if (s.type==='checkpoint') { lines.push(`echo "📌 ${s.label}"`); lines.push(''); }
          else lines.push(`# [${s.type}] 需要 Otto runtime\n`);
        }
        lines.push('echo "✅ 完成"');
        return `📄 Shell:\n\`\`\`bash\n${lines.join('\n')}\n\`\`\``;
      }
      default: throw new Error('Unknown format: '+format);
    }
  }
}
