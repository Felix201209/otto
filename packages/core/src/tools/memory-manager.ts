/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Memory Manager v2 - Auto-learning knowledge base + HR lifecycle.
 *
 * 4 core capabilities:
 * 1. Onboard: new employee inherits department + role knowledge instantly
 * 2. Offboard: departing employee's experience auto-merges into department
 * 3. Learn: every task execution auto-extracts knowledge, syncs in real-time
 * 4. Report: management sees token spend, time saved, ROI per role/dept
 *
 * Files structure:
 *   ~/.otto/memory/
 *   ├── employee.markdown       (local, personal habits + efficiency)
 *   ├── department.markdown     (cloud sync, SOPs + templates)
 *   ├── role.markdown           (cloud sync, role-specific workflows)
 *   ├── workflows/*.md          (task-specific templates)
 *   └── reports/
 *       ├── token_report.md     (monthly token spend by role/dept)
 *       └── efficiency_report.md (time saved, ROI)
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
import { Config } from '../config/config.js';
import { OrgMemoryStore } from '../memory/orgMemoryStore.js';
import { CodebaseMemoryProvider } from '../memory/codebaseMemoryProvider.js';
import { createProjectArchiveSummary, createSkillCandidate } from '../memory/skillFormation.js';
import type { OrgMemoryRecord, ProjectRecord, ProjectType, UsageRecord } from '../memory/orgMemoryTypes.js';
import { findMostSimilarTopic, DEFAULT_MERGE_THRESHOLD, type TopicCandidate } from '../utils/topicSimilarity.js';

const MEMORY_DIR = path.join(os.homedir(), '.otto', 'memory');
const WORKFLOWS_DIR = path.join(MEMORY_DIR, 'workflows');
const REPORTS_DIR = path.join(MEMORY_DIR, 'reports');

export interface MemoryManagerToolParams {
  action:
    | 'learn'      // Auto-extract knowledge from task execution
    | 'recall'     // Retrieve relevant knowledge before task
    | 'onboard'    // New employee inherits dept+role knowledge
    | 'offboard'   // Departing employee's experience merges to dept
    | 'report'     // Management: token spend, time saved, ROI
    | 'update'     // Manually update a knowledge file
    | 'sync'       // Prepare anonymized knowledge for cloud
    | 'export'     // Export all knowledge
    | 'project_create'
    | 'project_list'
    | 'project_add'
    | 'project_archive'
    | 'project_code_config'
    | 'project_code_status'
    | 'project_code_index'
    | 'project_code_arch'
    | 'project_code_search'
    | 'list';      // Show all knowledge files

  task_type?: string;
  context?: string;
  task_result?: string;
  employee_id?: string;
  department_id?: string;
  role_id?: string;
  target?: 'employee' | 'department' | 'role' | 'workflow';
  content?: string;
  output_path?: string;
  /** For report: time range (7d, 30d, 90d) */
  period?: string;
  /** For report: who is viewing ('employee' sees own, 'manager' sees aggregated) */
  viewer?: 'employee' | 'manager';
  project_id?: string;
  project_name?: string;
  project_type?: ProjectType;
  project_goal?: string;
  team_id?: string;
  company_id?: string;
  user_id?: string;
  memory_title?: string;
  repo_path?: string;
  mcp_server?: string;
  query?: string;
}

export class MemoryManagerTool extends BaseTool<MemoryManagerToolParams, ToolResult> {
  static readonly Name: string = 'memory_manager';

  constructor(private readonly config: Config) {
    const desc = `Otto Memory Manager v2 - Knowledge base + HR lifecycle.

ACTIONS:
  learn:     Auto-extract knowledge after task execution.
             {action:"learn", task_type:"listing_entry", context:"...", task_result:"success 3.2min"}
  recall:    Retrieve relevant knowledge before executing a task.
             {action:"recall", task_type:"listing_entry"}
  onboard:   New employee inherits ALL department + role knowledge instantly.
             {action:"onboard", employee_id:"new_hire_001", role_id:"real_estate_agent", department_id:"wangjing"}
  offboard:  Departing employee's experience auto-merges into department knowledge.
             Individual profile archived, no manual handover needed.
             {action:"offboard", employee_id:"zhangxue"}
  report:    Management dashboard: token spend, time saved, ROI by role/dept.
             {action:"report", period:"30d", viewer:"manager"}
             Employee version: {action:"report", period:"30d", viewer:"employee"}
  update:    Manually update knowledge file.
             {action:"update", target:"department", content:"## new SOP..."}
  sync:      Prepare anonymized knowledge for cloud upload.
  export:    Export all knowledge to single file.
  project_create: Create a staged-goal project memory container.
  project_list:   List organization memory projects.
  project_add:    Add a memory record to a project.
  project_archive: Archive a project and generate a candidate skill when usage qualifies.
  list:      Show all knowledge files and sizes.

FILES CREATED:
  ~/.otto/memory/employee.markdown   - Personal habits + efficiency (LOCAL)
  ~/.otto/memory/department.markdown - SOPs + templates (CLOUD SYNC)
  ~/.otto/memory/role.markdown       - Role workflows (CLOUD SYNC)
  ~/.otto/memory/workflows/*.md      - Task-specific templates
  ~/.otto/memory/reports/*.md        - Token + efficiency reports`;

    super(MemoryManagerTool.Name, 'MemoryManager', desc, Icon.Info,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            description: 'Memory operation',
            enum: ['learn', 'recall', 'onboard', 'offboard', 'report', 'update', 'sync', 'export', 'project_create', 'project_list', 'project_add', 'project_archive', 'project_code_config', 'project_code_status', 'project_code_index', 'project_code_arch', 'project_code_search', 'list'],
          },
          task_type: { type: Type.STRING, description: 'Task type: listing_entry, contract_generation, etc.' },
          context: { type: Type.STRING, description: 'What was done (for learn)' },
          task_result: { type: Type.STRING, description: 'Task outcome + duration (for learn)' },
          employee_id: { type: Type.STRING, description: 'Employee ID (defaults to OS username)' },
          department_id: { type: Type.STRING, description: 'Department ID' },
          role_id: { type: Type.STRING, description: 'Role ID: real_estate_agent, accountant, etc.' },
          target: { type: Type.STRING, description: 'Which file to update', enum: ['employee', 'department', 'role', 'workflow'] },
          content: { type: Type.STRING, description: 'Content to write' },
          output_path: { type: Type.STRING, description: 'Export output path' },
          period: { type: Type.STRING, description: 'Report period: 7d, 30d, 90d. Default: 30d' },
          viewer: { type: Type.STRING, description: 'Report viewer: employee (own stats) or manager (aggregated)', enum: ['employee', 'manager'] },
          project_id: { type: Type.STRING, description: 'Project id for project memory operations' },
          project_name: { type: Type.STRING, description: 'Project name for project_create' },
          project_type: { type: Type.STRING, description: 'Project type such as code, marketing, sales, product, docs, other' },
          project_goal: { type: Type.STRING, description: 'Project staged goal' },
          team_id: { type: Type.STRING, description: 'Team or department id' },
          company_id: { type: Type.STRING, description: 'Company id' },
          user_id: { type: Type.STRING, description: 'User id for ownership and attribution' },
          memory_title: { type: Type.STRING, description: 'Title for project_add memory record' },
          repo_path: { type: Type.STRING, description: 'Repository path for codebase-memory-mcp indexing' },
          mcp_server: { type: Type.STRING, description: 'MCP server name for codebase-memory-mcp' },
          query: { type: Type.STRING, description: 'Search query for project_code_search' },
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
    if (p.action === 'onboard' && !p.employee_id) return 'memory_manager/onboard: employee_id required';
    if (p.action === 'offboard' && !p.employee_id) return 'memory_manager/offboard: employee_id required';
    if (p.action === 'update' && (!p.target || !p.content)) return 'memory_manager/update: target and content required';
    if (p.action === 'project_create' && !p.project_name) return 'memory_manager/project_create: project_name required';
    if ((p.action === 'project_add' || p.action === 'project_archive' || p.action === 'project_code_config' || p.action === 'project_code_status' || p.action === 'project_code_index' || p.action === 'project_code_arch' || p.action === 'project_code_search') && !p.project_id) return 'memory_manager/project: project_id required';
    if (p.action === 'project_add' && !p.content) return 'memory_manager/project_add: content required';
    if (p.action === 'project_code_config' && !p.repo_path) return 'memory_manager/project_code_config: repo_path required';
    if (p.action === 'project_code_search' && !p.query) return 'memory_manager/project_code_search: query required';
    return null;
  }

  toolLocations(): ToolLocation[] { return []; }
  getDescription(p: MemoryManagerToolParams): string {
    return 'memory: ' + p.action + (p.task_type ? ' ' + p.task_type : '') + (p.employee_id ? ' ' + p.employee_id : '');
  }

  async shouldConfirmExecute(_p: MemoryManagerToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    return false;
  }

  async execute(p: MemoryManagerToolParams, _s: AbortSignal): Promise<ToolResult> {
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    this.ensureDirs();
    const logLabel = 'memory.' + p.action;
    console.time(logLabel);

    try {
      let r = '';
      switch (p.action) {
        case 'learn': r = this.learn(p); break;
        case 'recall': r = await this.recall(p); break;
        case 'onboard': r = this.onboard(p); break;
        case 'offboard': r = this.offboard(p); break;
        case 'report': r = this.report(p); break;
        case 'update': r = this.update(p); break;
        case 'sync': r = this.sync(p); break;
        case 'export': r = this.export(p); break;
        case 'project_create': r = await this.projectCreate(p); break;
        case 'project_list': r = await this.projectList(p); break;
        case 'project_add': r = await this.projectAdd(p); break;
        case 'project_archive': r = await this.projectArchive(p); break;
        case 'project_code_config': r = await this.projectCodeConfig(p); break;
        case 'project_code_status': r = await this.projectCodeStatus(p); break;
        case 'project_code_index': r = await this.projectCodeIndex(p); break;
        case 'project_code_arch': r = await this.projectCodeArch(p); break;
        case 'project_code_search': r = await this.projectCodeSearch(p); break;
        case 'list': r = this.list(); break;
        default: return { llmContent: 'memory FAIL: unknown action', returnDisplay: 'memory FAIL: unknown action' };
      }
      console.timeEnd(logLabel);
      return { llmContent: 'memory OK: ' + r, returnDisplay: 'memory OK: ' + r.split('\n')[0] };
    } catch (e: unknown) {
      console.timeEnd(logLabel);
      const m = e instanceof Error ? e.message : String(e);
      return { llmContent: 'memory FAIL: ' + m, returnDisplay: 'memory FAIL: ' + m };
    }
  }

  // ============================================================
  // LEARN: auto-extract knowledge from task execution
  // ============================================================
  private learn(p: MemoryManagerToolParams): string {
    const empId = p.employee_id || os.userInfo().username;
    const now = new Date().toISOString().split('T')[0];
    const durationMatch = p.task_result?.match(/(\d+\.?\d*)\s*min/);
    const duration = durationMatch ? parseFloat(durationMatch[1]) : 0;
    const success = p.task_result?.includes('fail') ? false : true;

    // 1. Update employee.markdown
    const empFile = path.join(MEMORY_DIR, 'employee.markdown');
    let empContent = fs.existsSync(empFile) ? fs.readFileSync(empFile, 'utf8') : `# Employee: ${empId}\n\n## Task History\n`;

    const record = `- [${now}] ${p.task_type}: ${(p.context || '').substring(0, 200)} -> ${p.task_result || 'ok'}${duration ? ' (' + duration + 'min)' : ''}\n`;
    empContent += record;

    // Track efficiency trend
    this.updateEfficiencyTrend(empFile, empContent, p.task_type!, duration, success);
    fs.writeFileSync(empFile, empContent);

    // 2. Update workflow file
    const wfFile = path.join(WORKFLOWS_DIR, p.task_type! + '.markdown');
    if (!fs.existsSync(wfFile)) {
      const wfContent = `# Workflow: ${p.task_type}\n\n## First Execution\n- Date: ${now}\n- Employee: ${empId}\n- Context: ${(p.context || '').substring(0, 500)}\n- Result: ${p.task_result || 'success'}\n- Duration: ${duration || 'unknown'}min\n\n## Steps\n(Auto-populated)\n`;
      fs.writeFileSync(wfFile, wfContent);
    } else {
      const wfContent = fs.readFileSync(wfFile, 'utf8');
      const execCount = (wfContent.match(/## Execution/g) || []).length + 1;
      const appendBlock = `\n## Execution ${execCount} [${now}]\n- Employee: ${empId}\n- Context: ${(p.context || '').substring(0, 300)}\n- Result: ${p.task_result || 'success'}\n- Duration: ${duration || 'unknown'}min\n`;
      fs.writeFileSync(wfFile, wfContent + appendBlock);

      // Auto-discover patterns after 3+ executions
      if (execCount >= 3) {
        this.discoverPatterns(wfFile, p.task_type!);
      }
    }

    return `Learned: task=${p.task_type}, duration=${duration || 'unknown'}min, success=${success}, employee=${empId}`;
  }

  // ============================================================
  // RECALL: retrieve relevant knowledge before task
  // ============================================================
  private async recall(p: MemoryManagerToolParams): Promise<string> {
    const parts: string[] = [];

    // 1. Employee history
    const empFile = path.join(MEMORY_DIR, 'employee.markdown');
    if (fs.existsSync(empFile)) {
      const emp = fs.readFileSync(empFile, 'utf8');
      const lines = emp.split('\n').filter(l => l.includes(p.task_type!));
      if (lines.length > 0) {
        parts.push('## Your History (last 3)');
        parts.push(lines.slice(-3).join('\n'));
      }
      // Efficiency trend
      const trendMatch = emp.match(new RegExp(`- ${p.task_type}: (.+)`));
      if (trendMatch) {
        parts.push(`## Your Efficiency Trend: ${trendMatch[1]}`);
      }
    }

    // 2. Department knowledge（本地 markdown，个人机器上的旧存储）
    const deptFile = path.join(MEMORY_DIR, 'department.markdown');
    if (fs.existsSync(deptFile)) {
      const dept = fs.readFileSync(deptFile, 'utf8');
      const sections = dept.split('\n## ');
      const relevant = sections.filter(s =>
        s.toLowerCase().includes(p.task_type!.toLowerCase()) ||
        s.toLowerCase().includes('sop') ||
        s.toLowerCase().includes('template') ||
        s.toLowerCase().includes('common')
      );
      if (relevant.length > 0) {
        parts.push('## Department Knowledge (local)');
        parts.push(relevant.slice(0, 3).map(s => '## ' + s).join('\n\n'));
      }
    }

    // 2.5 企业知识库桥接（统一部门/公司知识库）：
    //   之前部门知识只有本地 markdown 一份，与 enterprise server 的 SQLite
    //   knowledge 表（真正跨机器共享、按部门维度存储）完全不通——同一个 Otto
    //   装在两台机器上互相看不到对方学到的东西。这里尝试连一次本机/局域网的
    //   enterprise server（GET /enterprise/knowledge），拿到的结果与本地
    //   markdown 合并展示。企业服务端未启动是绝大多数个人用户的常态，此时
    //   静默跳过，不影响任何现有行为——不假装"服务端一定在跑"。
    const enterpriseKnowledge = await this.recallFromEnterprise(p);
    if (enterpriseKnowledge) {
      parts.push(enterpriseKnowledge);
    }

    // 3. Workflow template
    const wfFile = path.join(WORKFLOWS_DIR, p.task_type! + '.markdown');
    if (fs.existsSync(wfFile)) {
      parts.push('## Workflow Template');
      parts.push(fs.readFileSync(wfFile, 'utf8').substring(0, 1000));
    }

    return parts.length > 0 ? parts.join('\n\n') : `No prior knowledge for task_type=${p.task_type}. First execution.`;
  }

  /**
   * 从 Otto Enterprise 服务端（packages/server/src/enterprise）拉取部门知识，
   * 与本地 markdown 部门知识合并，实现"部门知识库统一"。
   *
   * 端点/鉴权/超时均可通过环境变量覆盖：
   *   OTTO_ENTERPRISE_URL         默认 http://127.0.0.1:7777（企业服务端默认监听地址）
   *   OTTO_ENTERPRISE_ADMIN_TOKEN 若企业服务端配置了 admin token 则需要
   *   OTTO_ENTERPRISE_RECALL_TIMEOUT_MS 默认 800ms —— 必须短，绝不能让本地
   *     recall（大多数场景企业服务端根本没启动）被网络等待拖慢。
   *
   * 失败模式全部静默降级为空字符串（服务端未启动 / 网络错误 / 超时 / 非 2xx
   * 响应 / JSON 解析失败），因为对绝大多数个人开发者用户，enterprise server
   * 本来就不会运行——这不是错误，是常态。
   */
  private async recallFromEnterprise(p: MemoryManagerToolParams): Promise<string | null> {
    const base = (process.env.OTTO_ENTERPRISE_URL || 'http://127.0.0.1:7777').replace(/\/$/, '');
    const timeoutMs = Number(process.env.OTTO_ENTERPRISE_RECALL_TIMEOUT_MS || 800);
    const department = p.department_id;

    const url = new URL(base + '/enterprise/knowledge');
    if (p.task_type) url.searchParams.set('q', p.task_type);
    if (department) url.searchParams.set('department', department);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const token = process.env.OTTO_ENTERPRISE_ADMIN_TOKEN;
      const headers: Record<string, string> = {};
      if (token) headers['x-otto-admin-token'] = token;

      const res = await fetch(url.toString(), { signal: controller.signal, headers });
      if (!res.ok) return null;

      const data = (await res.json()) as { knowledge?: Array<{ content?: string; category?: string; department?: string; confidence?: number }> };
      const items = Array.isArray(data.knowledge) ? data.knowledge : [];
      if (items.length === 0) return null;

      const lines = items.slice(0, 5).map((k) => {
        const dept = k.department ? `[${k.department}] ` : '';
        const cat = k.category ? `(${k.category}) ` : '';
        return `- ${dept}${cat}${k.content || ''}`;
      });
      return '## Department/Company Knowledge (enterprise server, shared across machines)\n' + lines.join('\n');
    } catch {
      // 企业服务端未启动 / 网络不可达 / 超时——静默降级，不当作错误。
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================================
  // ONBOARD: new employee inherits everything instantly
  // ============================================================
  private onboard(p: MemoryManagerToolParams): string {
    const empId = p.employee_id!;
    const empFile = path.join(MEMORY_DIR, 'employee.markdown');

    // Create fresh employee profile
    const profile = `# Employee: ${empId}

## Profile
- Role: ${p.role_id || 'unassigned'}
- Department: ${p.department_id || 'unassigned'}
- Onboarded: ${new Date().toISOString().split('T')[0]}
- Status: ACTIVE

## Task History
(No tasks yet - Otto will learn as you work)

## Efficiency Trends
(No data yet - Otto will track your improvement)

## Inherited Knowledge
`;

    let inherited = profile;

    // Inherit department knowledge
    const deptFile = path.join(MEMORY_DIR, 'department.markdown');
    if (fs.existsSync(deptFile)) {
      const dept = fs.readFileSync(deptFile, 'utf8');
      inherited += `### Department SOPs (inherited)\n${dept.substring(0, 2000)}\n\n`;
    }

    // Inherit role knowledge
    const roleFile = path.join(MEMORY_DIR, 'role.markdown');
    if (fs.existsSync(roleFile)) {
      const role = fs.readFileSync(roleFile, 'utf8');
      inherited += `### Role Workflows (inherited)\n${role.substring(0, 2000)}\n\n`;
    }

    // List available workflow templates
    if (fs.existsSync(WORKFLOWS_DIR)) {
      const wfs = fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.markdown'));
      if (wfs.length > 0) {
        inherited += `### Available Workflow Templates\n${wfs.map(w => '- ' + w.replace('.markdown', '')).join('\n')}\n`;
      }
    }

    fs.writeFileSync(empFile, inherited);

    return `Onboarded: ${empId}\nRole: ${p.role_id || 'unassigned'}\nDept: ${p.department_id || 'unassigned'}\nInherited: department SOPs + role workflows + ${fs.existsSync(WORKFLOWS_DIR) ? fs.readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith('.markdown')).length : 0} workflow templates\n\nDay 1 ready. No training needed.`;
  }

  // ============================================================
  // OFFBOARD: auto-merge experience into department, archive profile
  // ============================================================
  private offboard(p: MemoryManagerToolParams): string {
    const empId = p.employee_id!;
    const empFile = path.join(MEMORY_DIR, 'employee.markdown');

    if (!fs.existsSync(empFile)) {
      return `Employee ${empId} has no profile. Nothing to offboard.`;
    }

    const empContent = fs.readFileSync(empFile, 'utf8');
    const now = new Date().toISOString().split('T')[0];

    // 1. Extract transferable knowledge from employee profile
    const taskLines = empContent.split('\n').filter(l => l.startsWith('- ['));
    const efficiencyLines = empContent.split('\n').filter(l => l.includes('avg:'));

    // 2. Merge into department knowledge
    const deptFile = path.join(MEMORY_DIR, 'department.markdown');
    let deptContent = fs.existsSync(deptFile) ? fs.readFileSync(deptFile, 'utf8') : `# Department Knowledge Base\n`;

    const mergeBlock = `\n## Offboarded Experience [${empId}] [${now}]
### Task Patterns Learned
${taskLines.slice(-20).join('\n')}

### Efficiency Benchmarks
${efficiencyLines.join('\n')}

### Notes
- Auto-merged from ${empId}'s profile on ${now}
- Individual personal preferences NOT transferred (only methodology)
`;
    deptContent += mergeBlock;
    fs.writeFileSync(deptFile, deptContent);

    // 3. Archive employee profile
    const archiveDir = path.join(MEMORY_DIR, 'archive');
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
    const archiveFile = path.join(archiveDir, `${empId}_${now}.markdown`);
    fs.writeFileSync(archiveFile, empContent);

    // 4. Reset active employee profile
    fs.writeFileSync(empFile, `# Employee: (vacant)\n- Previous: ${empId} (offboarded ${now})\n- Experience merged to department knowledge\n- Awaiting new assignment\n`);

    return `Offboarded: ${empId}\n- ${taskLines.length} task records merged to department\n- ${efficiencyLines.length} efficiency benchmarks merged\n- Profile archived to: archive/${empId}_${now}.markdown\n- No manual handover needed. Next hire inherits everything.`;
  }

  // ============================================================
  // REPORT: token spend, time saved, ROI
  // ============================================================
  private report(p: MemoryManagerToolParams): string {
    const period = p.period || '30d';
    const viewer = p.viewer || 'employee';
    const empId = p.employee_id || os.userInfo().username;

    const empFile = path.join(MEMORY_DIR, 'employee.markdown');
    if (!fs.existsSync(empFile)) {
      return 'No employee profile found. Use Otto more to generate data.';
    }

    const emp = fs.readFileSync(empFile, 'utf8');

    // Parse task history
    const taskLines = emp.split('\n').filter(l => l.startsWith('- ['));
    const tasks = taskLines.map(l => {
      const durationMatch = l.match(/(\d+\.?\d*)\s*min/);
      const typeMatch = l.match(/\]\s+(\w+):/);
      const successMatch = l.includes('success') || l.includes('ok');
      return {
        type: typeMatch ? typeMatch[1] : 'unknown',
        duration: durationMatch ? parseFloat(durationMatch[1]) : 0,
        success: successMatch,
        raw: l,
      };
    });

    // Calculate metrics
    const totalTasks = tasks.length;
    const totalMinutes = tasks.reduce((sum, t) => sum + t.duration, 0);
    const avgDuration = totalTasks > 0 ? totalMinutes / totalTasks : 0;

    // Group by task type
    const byType: Record<string, { count: number; totalMin: number; avgMin: number }> = {};
    for (const t of tasks) {
      if (!byType[t.type]) byType[t.type] = { count: 0, totalMin: 0, avgMin: 0 };
      byType[t.type].count++;
      byType[t.type].totalMin += t.duration;
    }
    for (const [type, data] of Object.entries(byType)) {
      data.avgMin = data.totalMin / data.count;
    }

    // Estimate time saved (assume manual takes 3x Otto time)
    const estimatedManualMin = totalMinutes * 3;
    const timeSavedMin = estimatedManualMin - totalMinutes;
    const timeSavedHours = (timeSavedMin / 60).toFixed(1);

    // Estimate token cost (rough: ~2000 tokens per task, $0.002/1K tokens)
    const estTokensPerTask = 2000;
    const totalTokens = totalTasks * estTokensPerTask;
    const tokenCostCNY = (totalTokens / 1000 * 0.014).toFixed(2); // ~0.014 CNY per 1K tokens
    const hourlyRate = 50; // CNY per hour
    const moneySaved = ((timeSavedMin / 60) * hourlyRate).toFixed(0);
    const roi = parseFloat(tokenCostCNY) > 0 ? (parseFloat(moneySaved) / parseFloat(tokenCostCNY)).toFixed(0) : 'N/A';

    if (viewer === 'employee') {
      // Employee sees: how much time THEY saved
      let report = `## Your Otto Report (${period})\n\n`;
      report += `Tasks completed: ${totalTasks}\n`;
      report += `Time spent with Otto: ${totalMinutes.toFixed(0)} min\n`;
      report += `Estimated time without Otto: ${estimatedManualMin.toFixed(0)} min\n`;
      report += `Time saved: ${timeSavedHours} hours (${timeSavedMin.toFixed(0)} min)\n`;
      report += `That's ${(parseFloat(timeSavedHours) / 8).toFixed(1)} extra work days freed up.\n\n`;
      report += `### By Task Type\n`;
      report += `| Task | Count | Avg Time | Total Time |\n|------|-------|----------|------------|\n`;
      for (const [type, data] of Object.entries(byType)) {
        report += `| ${type} | ${data.count} | ${data.avgMin.toFixed(1)}min | ${data.totalMin.toFixed(0)}min |\n`;
      }
      return report;
    } else {
      // Manager sees: ROI, token spend, aggregated efficiency
      let report = `## Management Report (${period})\n\n`;
      report += `### ROI Summary\n`;
      report += `- Total tasks: ${totalTasks}\n`;
      report += `- Time saved: ${timeSavedHours} hours\n`;
      report += `- Estimated money saved: CNY ${moneySaved} (at ${hourlyRate} CNY/hour)\n`;
      report += `- Token cost: CNY ${tokenCostCNY}\n`;
      report += `- ROI: ${roi}x\n\n`;
      report += `### Token Spend Breakdown\n`;
      report += `| Task Type | Tasks | Est. Tokens | Est. Cost (CNY) |\n|-----------|-------|-------------|------------------|\n`;
      for (const [type, data] of Object.entries(byType)) {
        const tokens = data.count * estTokensPerTask;
        const cost = (tokens / 1000 * 0.014).toFixed(2);
        report += `| ${type} | ${data.count} | ${tokens.toLocaleString()} | ${cost} |\n`;
      }
      report += `| **Total** | **${totalTasks}** | **${totalTokens.toLocaleString()}** | **${tokenCostCNY}** |\n\n`;
      report += `### Efficiency Trends\n`;
      const trendLines = emp.split('\n').filter(l => l.includes('avg:'));
      if (trendLines.length > 0) {
        for (const line of trendLines) {
          report += `- ${line.replace('- ', '')}\n`;
        }
      } else {
        report += '(Not enough data for trends yet)\n';
      }
      report += `\n### Bottleneck Analysis\n`;
      const slowest = Object.entries(byType).sort((a, b) => b[1].avgMin - a[1].avgMin)[0];
      if (slowest) {
        report += `- Slowest task: ${slowest[0]} (avg ${slowest[1].avgMin.toFixed(1)}min) - consider optimizing\n`;
      }
      const mostFrequent = Object.entries(byType).sort((a, b) => b[1].count - a[1].count)[0];
      if (mostFrequent) {
        report += `- Most frequent: ${mostFrequent[0]} (${mostFrequent[1].count} times)\n`;
      }

      // Save report
      const reportFile = path.join(REPORTS_DIR, `report_${period}_${new Date().toISOString().split('T')[0]}.md`);
      fs.writeFileSync(reportFile, report);
      report += `\nReport saved: ${reportFile}`;

      return report;
    }
  }

  // ============================================================
  // UPDATE: manually update knowledge file
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
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    fs.writeFileSync(filePath, existing + '\n' + p.content + '\n');
    return `Updated ${p.target}.markdown (+${p.content!.length} chars)`;
  }

  // ============================================================
  // SYNC: anonymize + prepare for cloud
  // ============================================================
  private sync(p: MemoryManagerToolParams): string {
    const files: string[] = [];
    let totalSize = 0;
    for (const [name, fpath] of [['department', path.join(MEMORY_DIR, 'department.markdown')], ['role', path.join(MEMORY_DIR, 'role.markdown')]]) {
      if (fs.existsSync(fpath)) {
        let content = fs.readFileSync(fpath, 'utf8');
        content = content.replace(/1[3-9]\d{9}/g, '[PHONE_REDACTED]');
        content = content.replace(/[\w.-]+@[\w.-]+\.\w+/g, '[EMAIL_REDACTED]');
        content = content.replace(/Employee:\s*\w+/g, 'Employee: [REDACTED]');
        const tmpFile = path.join(os.tmpdir(), `otto_sync_${name}_${Date.now()}.md`);
        fs.writeFileSync(tmpFile, content);
        files.push(`${name}: ${tmpFile} (${content.length} chars)`);
        totalSize += content.length;
      }
    }
    return files.length > 0
      ? `Sync prepared (${totalSize} chars):\n${files.join('\n')}\n\nNote: Upload endpoint not configured. Files saved to temp.`
      : 'No knowledge files to sync.';
  }

  // ============================================================
  // EXPORT: all knowledge to single file
  // ============================================================
  private export(p: MemoryManagerToolParams): string {
    const outPath = p.output_path || path.join(os.homedir(), 'Desktop', 'otto_knowledge_export.md');
    const parts: string[] = ['# Otto Knowledge Export', `Generated: ${new Date().toISOString()}`, ''];
    const collect = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const item of fs.readdirSync(dir)) {
        const fp = path.join(dir, item);
        if (fs.statSync(fp).isFile() && item.endsWith('.markdown')) {
          parts.push(`---\n# ${prefix}/${item}\n`);
          parts.push(fs.readFileSync(fp, 'utf8'));
          parts.push('');
        }
      }
    };
    collect(MEMORY_DIR, 'memory');
    collect(WORKFLOWS_DIR, 'workflows');
    collect(REPORTS_DIR, 'reports');
    fs.writeFileSync(outPath, parts.join('\n'));
    return `Exported to: ${outPath} (${fs.statSync(outPath).size} bytes)`;
  }

  // ============================================================
  // LIST: show all knowledge files
  // ============================================================
  private list(): string {
    const parts: string[] = ['## Otto Memory Files\n'];
    const show = (name: string, fpath: string) => {
      if (fs.existsSync(fpath)) {
        const stat = fs.statSync(fpath);
        const lines = fs.readFileSync(fpath, 'utf8').split('\n').length;
        parts.push(`- ${name}: ${Math.round(stat.size / 1024)}KB, ${lines} lines`);
      }
    };
    show('employee.markdown (LOCAL)', path.join(MEMORY_DIR, 'employee.markdown'));
    show('department.markdown (CLOUD)', path.join(MEMORY_DIR, 'department.markdown'));
    show('role.markdown (CLOUD)', path.join(MEMORY_DIR, 'role.markdown'));
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
    if (fs.existsSync(REPORTS_DIR)) {
      const rps = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'));
      if (rps.length > 0) {
        parts.push('\n### Reports:');
        for (const rp of rps) parts.push(`- ${rp}`);
      }
    }
    return parts.join('\n');
  }

  private getOrgStore(): OrgMemoryStore {
    return new OrgMemoryStore(this.config.getProjectRoot());
  }

  private makeId(prefix: string, seed: string): string {
    const safe = seed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
    return prefix + '_' + (safe || Date.now().toString(36));
  }

  private async projectCreate(p: MemoryManagerToolParams): Promise<string> {
    const now = new Date().toISOString();
    const companyId = p.company_id || 'default-company';
    const teamId = p.team_id || 'default-team';
    const userId = p.user_id || os.userInfo().username;
    // 只有当 goal 与 name 不同（即用户真的补充了额外信息）时才拼进比较文本。
    // 之前无条件拼 name+' '+goal：projectCreate 落库时 goal 缺省会回退成
    // name 本身，导致"已存在项目"的比较文本变成 "name name"（重复一次），
    // 而"这次新请求"若同样没给 goal，比较文本只是 "name "（不重复）——
    // 两边拼接方式不对称，人为拉低了本该很高的相似度，把明显该合并的重写
    // 判成了新话题。两侧都用同一条规则（goal 与 name 相同则不重复拼入）
    // 才能保证比较是对称、公平的。
    const buildTopicText = (name: string, goal: string): string =>
      goal && goal !== name ? `${name} ${goal}` : name;
    const topicText = buildTopicText(p.project_name!, p.project_goal || '');

    // 话题识别：新建项目/任务前，先看看同公司下是否已有一个"活跃"（非归档）
    // 项目讲的是同一件事，只是换了个说法（常见于中文场景——同一件事被不同人
    // 或同一人不同时间用不同措辞重新提出）。命中则合并（把这次"创建请求"记
    // 成一条项目记忆，追加到已有项目），而不是产出一堆名字不同、内容重复的
    // 项目。只在同一 companyId 范围内比对——不同公司的项目本就该完全隔离，
    // 不应互相"合并"。已归档（archived）的项目不参与合并判定：一个项目被
    // 结束后，同名话题重新出现应视为"新一轮"，值得开新项目而不是塞进旧的
    // 归档记录里。
    const store = this.getOrgStore();
    const existing = await store.load();
    const candidates: TopicCandidate[] = existing.projects
      .filter((proj) => proj.companyId === companyId && proj.status !== 'archived')
      .map((proj) => ({ id: proj.id, text: buildTopicText(proj.name, proj.goal) }));

    const match = p.project_id ? null : findMostSimilarTopic(topicText, candidates, DEFAULT_MERGE_THRESHOLD);
    if (match) {
      const mergedInto = existing.projects.find((proj) => proj.id === match.id)!;
      const memory: OrgMemoryRecord = {
        id: this.makeId('memory', mergedInto.id + '_merge_' + Date.now()),
        scope: 'project',
        companyId: mergedInto.companyId,
        teamId: mergedInto.teamId,
        projectId: mergedInto.id,
        type: 'fact',
        title: 'Merged duplicate topic',
        content: `Recognized as the same topic as an existing project (similarity ${(match.score * 100).toFixed(0)}%). ` +
          `Original request: name="${p.project_name}", goal="${p.project_goal || p.project_name}".`,
        tags: ['topic-merge'],
        visibility: 'project_members',
        source: 'auto_learned',
        confidence: match.score,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
      };
      await store.addMemory(memory);
      return 'topic merged into existing project: ' + mergedInto.id + ' (' + mergedInto.name + ', similarity ' +
        (match.score * 100).toFixed(0) + '%) — not creating a duplicate';
    }

    // 未命中任何已有话题：这是一个新话题，正常新建。
    const project: ProjectRecord = {
      id: p.project_id || this.makeId('project', p.project_name!),
      companyId,
      teamId,
      name: p.project_name!,
      type: p.project_type || 'other',
      status: 'active',
      goal: p.project_goal || p.project_name!,
      ownerUserId: userId,
      memberUserIds: [userId],
      linkedSessionIds: [],
      assetRefs: [],
      createdAt: now,
      updatedAt: now,
    };
    await store.upsertProject(project);
    return 'project created: ' + project.id + ' (' + project.name + ')';
  }

  private async projectList(p: MemoryManagerToolParams): Promise<string> {
    const data = await this.getOrgStore().load();
    const projects = data.projects.filter((project) => {
      if (p.company_id && project.companyId !== p.company_id) return false;
      if (p.team_id && project.teamId !== p.team_id) return false;
      return true;
    });
    if (projects.length === 0) return 'no projects';
    return projects.map((project) => '- ' + project.id + ': ' + project.name + ' [' + project.status + '] ' + project.goal).join('\n');
  }

  private async projectAdd(p: MemoryManagerToolParams): Promise<string> {
    const data = await this.getOrgStore().load();
    const project = data.projects.find((item) => item.id === p.project_id);
    if (!project) throw new Error('project not found: ' + p.project_id);
    const now = new Date().toISOString();
    const memory: OrgMemoryRecord = {
      id: this.makeId('memory', project.id + '_' + Date.now()),
      scope: 'project',
      companyId: project.companyId,
      teamId: project.teamId,
      projectId: project.id,
      type: 'fact',
      title: p.memory_title || 'Project memory',
      content: p.content!,
      tags: [],
      visibility: 'project_members',
      source: 'manual',
      confidence: 1,
      createdBy: p.user_id || os.userInfo().username,
      createdAt: now,
      updatedAt: now,
    };
    await this.getOrgStore().addMemory(memory);
    return 'project memory added: ' + project.id + ' ' + memory.id;
  }

  private async projectArchive(p: MemoryManagerToolParams): Promise<string> {
    const store = this.getOrgStore();
    const data = await store.load();
    const project = data.projects.find((item) => item.id === p.project_id);
    if (!project) throw new Error('project not found: ' + p.project_id);
    const now = new Date().toISOString();
    const archivedProject: ProjectRecord = { ...project, status: 'archived', updatedAt: now, completedAt: now };
    await store.upsertProject(archivedProject);
    const memories = data.memories.filter((memory) => memory.projectId === project.id);
    const usage: UsageRecord[] = data.usage.filter((record) => record.projectId === project.id);
    const summary = createProjectArchiveSummary(archivedProject, memories);
    const summaryMemory: OrgMemoryRecord = {
      id: this.makeId('memory', project.id + '_archive'),
      scope: 'project',
      companyId: project.companyId,
      teamId: project.teamId,
      projectId: project.id,
      type: 'summary',
      title: 'Archive: ' + project.name,
      content: summary,
      tags: ['archive'],
      visibility: 'team_visible',
      source: 'auto_learned',
      confidence: 1,
      createdBy: p.user_id || os.userInfo().username,
      createdAt: now,
      updatedAt: now,
    };
    await store.addMemory(summaryMemory);
    const candidate = createSkillCandidate({ project: archivedProject, memories, usage, now, createdBy: summaryMemory.createdBy });
    if (candidate) {
      await store.addSkill(candidate);
      return 'project archived: ' + project.id + '\n' + 'candidate skill: ' + candidate.id;
    }
    return 'project archived: ' + project.id + '\n' + 'candidate skill: not enough successful repeated usage';
  }

  private async projectCodeConfig(p: MemoryManagerToolParams): Promise<string> {
    const store = this.getOrgStore();
    const data = await store.load();
    const project = data.projects.find((item) => item.id === p.project_id);
    if (!project) throw new Error('project not found: ' + p.project_id);
    const provider = new CodebaseMemoryProvider(this.config);
    const serverName = p.mcp_server || provider.getSuggestedMcpServerName();
    const codebase = provider.createConfig(p.repo_path!, serverName);
    await store.upsertProject({ ...project, codebase, updatedAt: new Date().toISOString() });
    const status = provider.requireConfigured(serverName);
    return [
      'project codebase memory configured: ' + project.id,
      'repo: ' + codebase.repoPath,
      'server: ' + serverName,
      status.message,
    ].join('\n');
  }

  private async projectCodeStatus(p: MemoryManagerToolParams): Promise<string> {
    const data = await this.getOrgStore().load();
    const project = data.projects.find((item) => item.id === p.project_id);
    if (!project) throw new Error('project not found: ' + p.project_id);
    if (!project.codebase) return 'codebase memory not configured for project: ' + project.id;
    const provider = new CodebaseMemoryProvider(this.config);
    const status = provider.requireConfigured(project.codebase.mcpServerName);
    return [
      'project codebase memory: ' + project.id,
      'repo: ' + project.codebase.repoPath,
      'server: ' + project.codebase.mcpServerName,
      'indexStatus: ' + project.codebase.indexStatus,
      status.message,
    ].join('\n');
  }

  private getProjectCodebaseOrThrow(p: MemoryManagerToolParams): ProjectRecord {
    const data = this.cachedProjectData;
    const project = data?.projects.find((item) => item.id === p.project_id);
    if (!project) throw new Error('project not found: ' + p.project_id);
    if (!project.codebase) throw new Error('codebase memory not configured for project: ' + project.id);
    return project;
  }

  private cachedProjectData: Awaited<ReturnType<OrgMemoryStore['load']>> | undefined;

  private async projectCodeIndex(p: MemoryManagerToolParams): Promise<string> {
    this.cachedProjectData = await this.getOrgStore().load();
    const project = this.getProjectCodebaseOrThrow(p);
    const result = await new CodebaseMemoryProvider(this.config).indexRepository(project.codebase!);
    return ['project code index: ' + project.id, result.message].join('\n');
  }

  private async projectCodeArch(p: MemoryManagerToolParams): Promise<string> {
    this.cachedProjectData = await this.getOrgStore().load();
    const project = this.getProjectCodebaseOrThrow(p);
    const result = await new CodebaseMemoryProvider(this.config).getArchitecture(project.codebase!);
    return ['project code architecture: ' + project.id, result.message, JSON.stringify(result.data ?? null)].join('\n');
  }

  private async projectCodeSearch(p: MemoryManagerToolParams): Promise<string> {
    this.cachedProjectData = await this.getOrgStore().load();
    const project = this.getProjectCodebaseOrThrow(p);
    const result = await new CodebaseMemoryProvider(this.config).searchGraph(project.codebase!, p.query!);
    return ['project code search: ' + project.id, result.message, JSON.stringify(result.data ?? null)].join('\n');
  }

  // ============================================================
  // Helpers
  // ============================================================
  private ensureDirs(): void {
    for (const d of [MEMORY_DIR, WORKFLOWS_DIR, REPORTS_DIR]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
  }

  private updateEfficiencyTrend(empFile: string, content: string, taskType: string, duration: number, success: boolean): void {
    if (duration <= 0) return;
    const sectionHeader = '## Efficiency Trends';
    let c = content;
    if (!c.includes(sectionHeader)) c += `\n${sectionHeader}\n`;
    const trendPattern = new RegExp(`- ${taskType}: (.+)`, 'g');
    const match = trendPattern.exec(c);
    if (match) {
      const dataPoints = match[1].split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
      dataPoints.push(duration);
      const recent = dataPoints.slice(-10);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const trend = recent.length > 1 && recent[recent.length - 1] < avg ? 'improving' : 'stable';
      c = c.replace(trendPattern, `- ${taskType}: ${recent.join(', ')} (avg: ${avg.toFixed(1)}min, ${trend})`);
    } else {
      c += `- ${taskType}: ${duration} (first record)\n`;
    }
    fs.writeFileSync(empFile, c);
  }

  private discoverPatterns(wfFile: string, taskType: string): void {
    // Read all execution records and find common patterns
    const content = fs.readFileSync(wfFile, 'utf8');
    const executions = content.split('## Execution').filter(s => s.trim());
    if (executions.length < 3) return;

    // Extract durations to find average
    const durations: number[] = [];
    for (const exec of executions) {
      const m = exec.match(/Duration:\s*(\d+\.?\d*)\s*min/);
      if (m) durations.push(parseFloat(m[1]));
    }

    if (durations.length >= 3) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const min = Math.min(...durations);
      const max = Math.max(...durations);

      // Check if pattern section already exists
      if (!content.includes('## Discovered Patterns')) {
        const patternBlock = `\n## Discovered Patterns\n- Total executions: ${durations.length}\n- Average duration: ${avg.toFixed(1)}min\n- Fastest: ${min}min\n- Slowest: ${max}min\n- Trend: ${durations[durations.length - 1] < avg ? 'improving' : 'stable'}\n`;
        fs.writeFileSync(wfFile, content + patternBlock);
      }
    }
  }
}
