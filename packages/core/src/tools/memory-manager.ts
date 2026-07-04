/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Memory Manager - Auto-learning knowledge base for departments and employees.
 * Learns from every task execution, stores as .markdown files, syncs to cloud.
 *
 * Files structure:
 *   ~/.otto/memory/
 *   ├── employee.markdown   (local, personal habits + efficiency)
 *   ├── department.markdown (cloud sync, SOPs + templates + common errors)
 *   ├── role.markdown       (cloud sync, role-specific workflows)
 *   └── workflows/
 *       ├── <task>.markdown (specific workflow templates)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  ToolConfirmationOutcome, Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';

const execAsync = promisify(exec);

const MEMORY_DIR = path.join(os.homedir(), '.otto', 'memory');
const WORKFLOWS_DIR = path.join(MEMORY_DIR, 'workflows');

export interface MemoryManagerToolParams {
  action: 'learn' | 'recall' | 'update' | 'sync' | 'export' | 'list';
  /** What task was just executed (for learn/recall) */
  task_type?: string;
  /** The natural language context of the task */
  context?: string;
  /** Result of the task execution (for learn) */
  task_result?: string;
  /** Employee identifier (defaults to system user) */
  employee_id?: string;
  /** Department identifier */
  department_id?: string;
  /** Role identifier (e.g. "real_estate_agent") */
  role_id?: string;
  /** For update: which file to update */
  target?: 'employee' | 'department' | 'role' | 'workflow';
  /** For update/sync: specific content to write */
  content?: string;
  /** For export: output file path */
  output_path?: string;
}

interface KnowledgeEntry {
  category: string;
  content: string;
  source: string;
  timestamp: string;
  confidence: number;
}

export class MemoryManagerTool extends BaseTool<MemoryManagerToolParams, ToolResult> {
  static readonly Name: string = 'memory_manager';

  constructor(private readonly config: Config) {
    const desc = `Otto Memory Manager - Auto-learning knowledge base.

Files created automatically:
  ~/.otto/memory/employee.markdown   - Personal habits, efficiency data (LOCAL)
  ~/.otto/memory/department.markdown - SOPs, templates, common errors (CLOUD SYNC)
  ~/.otto/memory/role.markdown       - Role-specific workflows (CLOUD SYNC)
  ~/.otto/memory/workflows/*.md      - Task-specific templates

EXAMPLES:
  learn: {action:"learn", task_type:"listing_entry", context:"User录入望京西园3栋1202...", task_result:"success 3.2min"}
  recall: {action:"recall", task_type:"listing_entry"} -> returns relevant knowledge
  update: {action:"update", target:"department", content:"## 新增: 望京西园物业费2.5元"}
  sync: {action:"sync"} -> upload department+role to cloud (anonymized)
  export: {action:"export", output_path:"~/Desktop/knowledge_export.md"}
  list: {action:"list"} -> show all knowledge files and sizes`;

    super(MemoryManagerTool.Name, 'MemoryManager', desc, Icon.Info,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            description: 'Memory operation',
            enum: ['learn', 'recall', 'update', 'sync', 'export', 'list'],
          },
          task_type: { type: Type.STRING, description: 'Task type: listing_entry, contract_generation, inspection_report, data_analysis, etc.' },
          context: { type: Type.STRING, description: 'Natural language description of what was done' },
          task_result: { type: Type.STRING, description: 'Outcome of the task (success/fail + duration)' },
          employee_id: { type: Type.STRING, description: 'Employee ID (defaults to OS username)' },
          department_id: { type: Type.STRING, description: 'Department ID for cloud sync' },
          role_id: { type: Type.STRING, description: 'Role ID: real_estate_agent, accountant, etc.' },
          target: { type: Type.STRING, description: 'Which knowledge file to update', enum: ['employee', 'department', 'role', 'workflow'] },
          content: { type: Type.STRING, description: 'Content to write/update in the target file' },
          output_path: { type: Type.STRING, description: 'Export output path' },
        },
        required: ['action'],
      },
    );
  }

  validateToolParams(p: MemoryManagerToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, MemoryManagerTool.Name);
    if (e) return e;
    if (p.action === 'learn' && !p.task_type) return 'memory_manager/learn: task_type required';
    if (p.action === 'recall' && !p.task_type) return 'memory_manager/recall: task_type required';
    if (p.action === 'update' && (!p.target || !p.content)) return 'memory_manager/update: target and content required';
    return null;
  }

  toolLocations(): ToolLocation[] { return []; }

  getDescription(p: MemoryManagerToolParams): string {
    return 'memory: ' + p.action + (p.task_type ? ' ' + p.task_type : '');
  }

  async shouldConfirmExecute(_p: MemoryManagerToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    return false; // memory operations are safe, auto-approve
  }

  async execute(p: MemoryManagerToolParams, _s: AbortSignal): Promise<ToolResult> {
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    this.ensureDirs();

    try {
      let r = '';
      switch (p.action) {
        case 'learn': r = await this.learn(p); break;
        case 'recall': r = await this.recall(p); break;
        case 'update': r = this.update(p); break;
        case 'sync': r = await this.sync(p); break;
        case 'export': r = this.export(p); break;
        case 'list': r = this.list(); break;
        default: return { llmContent: 'memory_manager FAIL: unknown action', returnDisplay: 'memory_manager FAIL: unknown action' };
      }
      return { llmContent: 'memory_manager OK: ' + r, returnDisplay: 'memory_manager OK: ' + r.split('\n')[0] };
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return { llmContent: 'memory_manager FAIL: ' + m, returnDisplay: 'memory_manager FAIL: ' + m };
    }
  }

  // ============================================================
  // Core: learn - extract knowledge from task execution
  // ============================================================
  private async learn(p: MemoryManagerToolParams): Promise<string> {
    const empId = p.employee_id || os.userInfo().username;
    const now = new Date().toISOString().split('T')[0];

    // 1. Update employee.markdown with task execution record
    const empFile = path.join(MEMORY_DIR, 'employee.markdown');
    let empContent = '';
    if (fs.existsSync(empFile)) {
      empContent = fs.readFileSync(empFile, 'utf8');
    } else {
      empContent = `# Employee Profile: ${empId}\n\n## Task History\n`;
    }

    // Extract duration from task_result if present
    const durationMatch = p.task_result?.match(/(\d+\.?\d*)\s*min/);
    const duration = durationMatch ? durationMatch[1] : 'unknown';

    // Append task record
    const record = `- [${now}] ${p.task_type}: ${p.context?.substring(0, 200) || ''} -> ${p.task_result || 'ok'} (${duration}min)\n`;
    empContent += record;
    fs.writeFileSync(empFile, empContent);

    // 2. Extract knowledge for department.markdown
    // Simple extraction: if context contains patterns like locations, templates, etc.
    const deptFile = path.join(MEMORY_DIR, 'department.markdown');
    let deptContent = '';
    if (fs.existsSync(deptFile)) {
      deptContent = fs.readFileSync(deptFile, 'utf8');
    } else {
      deptContent = `# Department Knowledge Base\n\n## Auto-generated by Otto\n`;
    }

    // Check if this task_type has a workflow file
    const wfFile = path.join(WORKFLOWS_DIR, p.task_type! + '.markdown');
    if (!fs.existsSync(wfFile)) {
      // Create workflow template from first execution
      const wfContent = `# Workflow: ${p.task_type}\n\n## First Execution\n- Date: ${now}\n- Employee: ${empId}\n- Context: ${p.context?.substring(0, 500) || 'N/A'}\n- Result: ${p.task_result || 'success'}\n- Duration: ${duration}min\n\n## Steps\n(Auto-populated as more executions are recorded)\n`;
      fs.writeFileSync(wfFile, wfContent);
    } else {
      // Append to existing workflow
      const wfContent = fs.readFileSync(wfFile, 'utf8');
      const appendBlock = `\n## Execution [${now}]\n- Employee: ${empId}\n- Context: ${p.context?.substring(0, 300) || 'N/A'}\n- Result: ${p.task_result || 'success'}\n- Duration: ${duration}min\n`;
      fs.writeFileSync(wfFile, wfContent + appendBlock);
    }

    // 3. Track efficiency trend in employee file
    this.updateEfficiencyTrend(empFile, p.task_type!, parseFloat(duration) || 0);

    return `Learned: task=${p.task_type}, duration=${duration}min, employee=${empId}`;
  }

  // ============================================================
  // Core: recall - retrieve relevant knowledge
  // ============================================================
  private async recall(p: MemoryManagerToolParams): Promise<string> {
    const parts: string[] = [];

    // 1. Check employee habits
    const empFile = path.join(MEMORY_DIR, 'employee.markdown');
    if (fs.existsSync(empFile)) {
      const emp = fs.readFileSync(empFile, 'utf8');
      // Find last 3 executions of same task_type
      const lines = emp.split('\n').filter(l => l.includes(p.task_type!));
      if (lines.length > 0) {
        parts.push('## Employee History (last 3)');
        parts.push(lines.slice(-3).join('\n'));
      }
    }

    // 2. Check department knowledge
    const deptFile = path.join(MEMORY_DIR, 'department.markdown');
    if (fs.existsSync(deptFile)) {
      const dept = fs.readFileSync(deptFile, 'utf8');
      // Find sections relevant to task_type
      const sections = dept.split('\n## ');
      const relevant = sections.filter(s =>
        s.toLowerCase().includes(p.task_type!.toLowerCase()) ||
        s.toLowerCase().includes('sop') ||
        s.toLowerCase().includes('template')
      );
      if (relevant.length > 0) {
        parts.push('## Department Knowledge');
        parts.push(relevant.slice(0, 3).map(s => '## ' + s).join('\n\n'));
      }
    }

    // 3. Check workflow file
    const wfFile = path.join(WORKFLOWS_DIR, p.task_type! + '.markdown');
    if (fs.existsSync(wfFile)) {
      const wf = fs.readFileSync(wfFile, 'utf8');
      parts.push('## Workflow Template');
      parts.push(wf.substring(0, 1000));
    }

    if (parts.length === 0) {
      return `No prior knowledge for task_type=${p.task_type}. This may be the first execution.`;
    }

    return parts.join('\n\n');
  }

  // ============================================================
  // Core: update - manually update a knowledge file
  // ============================================================
  private update(p: MemoryManagerToolParams): string {
    const targetMap: Record<string, string> = {
      'employee': path.join(MEMORY_DIR, 'employee.markdown'),
      'department': path.join(MEMORY_DIR, 'department.markdown'),
      'role': path.join(MEMORY_DIR, 'role.markdown'),
      'workflow': path.join(WORKFLOWS_DIR, (p.task_type || 'general') + '.markdown'),
    };

    const filePath = targetMap[p.target!];
    if (!filePath) return 'Invalid target: ' + p.target;

    let existing = '';
    if (fs.existsSync(filePath)) {
      existing = fs.readFileSync(filePath, 'utf8');
    }

    // Append content (don't overwrite)
    const updated = existing + '\n' + p.content + '\n';
    fs.writeFileSync(filePath, updated);

    return `Updated ${p.target}.markdown (+${p.content!.length} chars)`;
  }

  // ============================================================
  // Core: sync - prepare anonymized knowledge for cloud upload
  // ============================================================
  private async sync(p: MemoryManagerToolParams): Promise<string> {
    const deptFile = path.join(MEMORY_DIR, 'department.markdown');
    const roleFile = path.join(MEMORY_DIR, 'role.markdown');

    const files: string[] = [];
    let totalSize = 0;

    for (const [name, fpath] of [['department', deptFile], ['role', roleFile]]) {
      if (fs.existsSync(fpath)) {
        let content = fs.readFileSync(fpath, 'utf8');
        // Anonymize: remove employee names, phone numbers, emails
        content = content.replace(/1[3-9]\d{9}/g, '[PHONE_REDACTED]');
        content = content.replace(/[\w.-]+@[\w.-]+\.\w+/g, '[EMAIL_REDACTED]');
        content = content.replace(/Employee:\s*\w+/g, 'Employee: [REDACTED]');

        // Write anonymized version to temp
        const tmpFile = path.join(os.tmpdir(), `otto_sync_${name}_${Date.now()}.md`);
        fs.writeFileSync(tmpFile, content);
        files.push(`${name}: ${tmpFile} (${content.length} chars)`);
        totalSize += content.length;
      }
    }

    if (files.length === 0) {
      return 'No knowledge files to sync. Use the tool more to build knowledge first.';
    }

    return `Sync prepared (${totalSize} chars total):\n${files.join('\n')}\n\nNote: Cloud upload endpoint not configured. Files saved to temp for manual upload.`;
  }

  // ============================================================
  // Core: export - export all knowledge to a single file
  // ============================================================
  private export(p: MemoryManagerToolParams): string {
    const outPath = p.output_path || path.join(os.homedir(), 'Desktop', 'otto_knowledge_export.md');
    const parts: string[] = ['# Otto Knowledge Export', `Generated: ${new Date().toISOString()}`, ''];

    // Collect all knowledge files
    const collectFiles = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && item.endsWith('.markdown')) {
          parts.push(`---\n# ${prefix}/${item}\n`);
          parts.push(fs.readFileSync(fullPath, 'utf8'));
          parts.push('');
        }
      }
    };

    collectFiles(MEMORY_DIR, 'memory');
    collectFiles(WORKFLOWS_DIR, 'workflows');

    fs.writeFileSync(outPath, parts.join('\n'));
    return `Exported to: ${outPath} (${fs.statSync(outPath).size} bytes)`;
  }

  // ============================================================
  // Core: list - show all knowledge files
  // ============================================================
  private list(): string {
    const parts: string[] = ['## Otto Memory Files\n'];

    const showFile = (name: string, fpath: string) => {
      if (fs.existsSync(fpath)) {
        const stat = fs.statSync(fpath);
        const content = fs.readFileSync(fpath, 'utf8');
        const lines = content.split('\n').length;
        parts.push(`- ${name}: ${Math.round(stat.size / 1024)}KB, ${lines} lines`);
      }
    };

    showFile('employee.markdown (LOCAL)', path.join(MEMORY_DIR, 'employee.markdown'));
    showFile('department.markdown (CLOUD)', path.join(MEMORY_DIR, 'department.markdown'));
    showFile('role.markdown (CLOUD)', path.join(MEMORY_DIR, 'role.markdown'));

    if (fs.existsSync(WORKFLOWS_DIR)) {
      const wfs = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.markdown'));
      if (wfs.length > 0) {
        parts.push('\n### Workflows:');
        for (const wf of wfs) {
          const stat = fs.statSync(path.join(WORKFLOWS_DIR, wf));
          parts.push(`- ${wf}: ${Math.round(stat.size / 1024)}KB`);
        }
      }
    }

    return parts.join('\n');
  }

  // ============================================================
  // Helpers
  // ============================================================
  private ensureDirs(): void {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
    if (!fs.existsSync(WORKFLOWS_DIR)) {
      fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
    }
  }

  private updateEfficiencyTrend(empFile: string, taskType: string, duration: number): void {
    if (duration <= 0) return;
    let content = fs.readFileSync(empFile, 'utf8');

    // Find or create efficiency section
    const sectionHeader = '## Efficiency Trends';
    if (!content.includes(sectionHeader)) {
      content += `\n${sectionHeader}\n`;
    }

    // Find task trend line
    const trendPattern = new RegExp(`- ${taskType}: (.+)`, 'g');
    const match = trendPattern.exec(content);

    if (match) {
      // Parse existing trend data
      const dataPoints = match[1].split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
      dataPoints.push(duration);
      // Keep last 10 data points
      const recent = dataPoints.slice(-10);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const trend = recent.length > 1 && recent[recent.length - 1] < avg ? 'improving' : 'stable';
      content = content.replace(trendPattern, `- ${taskType}: ${recent.join(', ')} (avg: ${avg.toFixed(1)}min, ${trend})`);
    } else {
      // Add new trend line
      content += `- ${taskType}: ${duration} (first record)\n`;
    }

    fs.writeFileSync(empFile, content);
  }
}
