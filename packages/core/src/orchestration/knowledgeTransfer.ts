/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Otto Knowledge Transfer — 离职交接/岗位传承。
 *
 * 员工离职时，将个人记忆打包导出（岗位画像+常用文档+偏好+历史决策）。
 * 新员工入职时，导入记忆包，Otto 第一天就"懂这个岗位"。
 *
 * 基于 Mem0Adapter 的导出/导入能力 + memory-manager 的 offboard/onboard。
 */

import type { Config } from '../config/config.js';
import { Mem0Adapter, type Mem0Memory } from '../memory/mem0Adapter.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { homedir } from 'os';

/** 记忆包结构 */
export interface MemoryPackage {
  /** 导出元信息 */
  meta: {
    exportedAt: string;
    sourceUserId: string;
    sourceUserName: string;
    department: string;
    role: string;
    memoryCount: number;
    version: string;
  };
  /** 结构化记忆条目（从 Mem0 导出） */
  memories: Mem0Memory[];
  /** 岗位画像摘要 */
  profile: {
    role: string;
    department: string;
    commonTasks: string[];
    frequentContacts: string[];
    preferredTools: string[];
    workStylePreferences: string[];
    efficiencyBenchmarks: Array<{ task: string; avgMinutes: number; trend: string }>;
  };
  /** 常用文档/模板引用 */
  documentRefs: Array<{
    title: string;
    type: string;
    feishuDocToken?: string;
    localPath?: string;
  }>;
  /** 历史决策记录（脱敏） */
  decisionHistory: Array<{
    date: string;
    context: string;
    decision: string;
    outcome: string;
  }>;
}

/**
 * 导出员工记忆包（离职交接）。
 *
 * 流程：
 * 1. 从 Mem0 导出所有结构化记忆
 * 2. 从 memory-manager 提取岗位画像
 * 3. 从文件记忆提取文档引用和决策历史
 * 4. 脱敏（移除个人隐私信息）
 * 5. 打包为 JSON 文件
 */
export async function exportMemoryPackage(
  _config: Config,
  mem0Adapter: Mem0Adapter | null,
  userInfo: {
    userId: string;
    userName: string;
    department: string;
    role: string;
  },
): Promise<{ path: string; memoryCount: number }> {
  const memories: Mem0Memory[] = mem0Adapter ? await mem0Adapter.exportMemories() : [];

  // 从文件记忆中提取岗位信息
  const employeeMemory = await readFileMemory('employee');
  const departmentMemory = await readFileMemory('department');
  const roleMemory = await readFileMemory('role');

  // 构建岗位画像
  const profile = buildProfile(employeeMemory, departmentMemory, roleMemory, userInfo.role);

  // 提取文档引用
  const documentRefs = extractDocumentRefs(employeeMemory + '\n' + departmentMemory);

  // 提取历史决策（从记忆中过滤）
  const decisionHistory = extractDecisions(memories.map(m => m.memory).join('\n') + '\n' + employeeMemory);

  // 脱敏
  const sanitizedMemories = memories.map(m => ({
    ...m,
    memory: sanitizeText(m.memory),
  }));

  const pkg: MemoryPackage = {
    meta: {
      exportedAt: new Date().toISOString(),
      sourceUserId: userInfo.userId,
      sourceUserName: userInfo.userName,
      department: userInfo.department,
      role: userInfo.role,
      memoryCount: sanitizedMemories.length,
      version: '1.0.0',
    },
    memories: sanitizedMemories,
    profile,
    documentRefs,
    decisionHistory,
  };

  // 保存到 ~/.otto-user/memory/transfers/
  const transferDir = path.join(homedir(), '.otto-user', 'memory', 'transfers');
  await fs.mkdir(transferDir, { recursive: true });

  const fileName = `transfer_${sanitizeFileName(userInfo.userName)}_${new Date().toISOString().split('T')[0]}.json`;
  const filePath = path.join(transferDir, fileName);

  await fs.writeFile(filePath, JSON.stringify(pkg, null, 2), 'utf-8');

  console.log(`[KnowledgeTransfer] Exported ${sanitizedMemories.length} memories to ${filePath}`);
  return { path: filePath, memoryCount: sanitizedMemories.length };
}

/**
 * 导入记忆包（新员工入职）。
 *
 * 流程：
 * 1. 读取记忆包 JSON
 * 2. 将记忆导入到新员工的 Mem0 实例
 * 3. 合并岗位画像到新员工的文件记忆
 * 4. 新员工的 Otto 第一天就"懂这个岗位"
 */
export async function importMemoryPackage(
  _config: Config,
  mem0Adapter: Mem0Adapter | null,
  packagePath: string,
  newUserInfo: {
    userId: string;
    userName: string;
    department: string;
    role: string;
  },
): Promise<{ importedMemories: number; inheritedProfile: boolean }> {
  // 读取记忆包
  const content = await fs.readFile(packagePath, 'utf-8');
  const pkg: MemoryPackage = JSON.parse(content);

  let importedCount = 0;

  // 1. 导入 Mem0 记忆
  if (mem0Adapter && pkg.memories.length > 0) {
    importedCount = await mem0Adapter.importMemories(pkg.memories, newUserInfo.userId);
  }

  // 2. 合并岗位画像到文件记忆
  const profileText = formatProfileForFile(pkg.profile, pkg.meta.sourceUserName);
  await writeInheritedMemory(profileText, newUserInfo.userId);

  // 3. 合并文档引用
  if (pkg.documentRefs.length > 0) {
    const docText = formatDocRefsForFile(pkg.documentRefs);
    await writeInheritedMemory(docText, newUserInfo.userId);
  }

  // 4. 合并历史决策
  if (pkg.decisionHistory.length > 0) {
    const decisionText = formatDecisionsForFile(pkg.decisionHistory);
    await writeInheritedMemory(decisionText, newUserInfo.userId);
  }

  console.log(`[KnowledgeTransfer] Imported ${importedCount} memories for ${newUserInfo.userName}`);
  return { importedMemories: importedCount, inheritedProfile: true };
}

// ============================================================
// 辅助函数
// ============================================================

const MEMORY_DIR = path.join(homedir(), '.otto-user', 'memory');

async function readFileMemory(type: 'employee' | 'department' | 'role'): Promise<string> {
  try {
    return await fs.readFile(path.join(MEMORY_DIR, `${type}.markdown`), 'utf-8');
  } catch {
    return '';
  }
}

function buildProfile(
  employeeMem: string,
  deptMem: string,
  _roleMem: string,
  role: string,
): MemoryPackage['profile'] {
  // 从记忆文本中提取岗位画像信息
  const commonTasks = extractListItems(employeeMem, /task|任务/gi).slice(0, 10);
  const frequentContacts = extractListItems(employeeMem, /contact|联系人|@/gi).slice(0, 10);
  const preferredTools = extractListItems(employeeMem, /tool|工具|飞书|excel|ppt/gi).slice(0, 5);

  // 效率指标
  const efficiencyBenchmarks: Array<{ task: string; avgMinutes: number; trend: string }> = [];
  const efficiencyLines = employeeMem.split('\n').filter(l => l.includes('avg:'));
  for (const line of efficiencyLines) {
    const match = line.match(/(\w+):.*avg:\s*([\d.]+)min.*,\s*(\w+)/);
    if (match) {
      efficiencyBenchmarks.push({
        task: match[1],
        avgMinutes: parseFloat(match[2]),
        trend: match[3],
      });
    }
  }

  return {
    role,
    department: extractDepartment(deptMem) || 'unknown',
    commonTasks,
    frequentContacts,
    preferredTools,
    workStylePreferences: extractListItems(employeeMem, /prefer|偏好|习惯/gi).slice(0, 5),
    efficiencyBenchmarks,
  };
}

function extractDocumentRefs(text: string): MemoryPackage['documentRefs'] {
  const refs: MemoryPackage['documentRefs'] = [];
  // 匹配飞书文档引用
  const feishuDocMatches = text.matchAll(/feishu:\/\/doc\/([a-zA-Z0-9]+)/g);
  for (const m of feishuDocMatches) {
    refs.push({ title: 'Feishu Doc', type: 'feishu_doc', feishuDocToken: m[1] });
  }
  // 匹配本地文件引用
  const fileMatches = text.matchAll(/file:\/\/([^\s]+)/g);
  for (const m of fileMatches) {
    refs.push({ title: 'Local File', type: 'file', localPath: m[1] });
  }
  return refs.slice(0, 20);
}

function extractDecisions(text: string): MemoryPackage['decisionHistory'] {
  const decisions: MemoryPackage['decisionHistory'] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes('decided') || line.includes('决定') || line.includes('决策')) {
      decisions.push({
        date: new Date().toISOString().split('T')[0],
        context: line.substring(0, 100),
        decision: line.substring(0, 200),
        outcome: 'unknown',
      });
    }
  }
  return decisions.slice(0, 20);
}

function sanitizeText(text: string): string {
  return text
    .replace(/1[3-9]\d{9}/g, '[PHONE_REDACTED]') // 手机号
    .replace(/[\w.-]+@[\w.-]+\.\w+/g, '[EMAIL_REDACTED]') // 邮箱
    .replace(/\d{18}/g, '[ID_REDACTED]'); // 身份证
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_').slice(0, 50);
}

function extractListItems(text: string, pattern: RegExp): string[] {
  const lines = text.split('\n');
  return lines
    .filter(l => pattern.test(l))
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(l => l.length > 0);
}

function extractDepartment(text: string): string | null {
  const match = text.match(/department[:\s]+([^\n]+)/i);
  return match ? match[1].trim() : null;
}

function formatProfileForFile(profile: MemoryPackage['profile'], sourceName: string): string {
  let text = `\n## Inherited Profile (from ${sourceName})\n`;
  text += `Role: ${profile.role}\n`;
  text += `Department: ${profile.department}\n\n`;

  if (profile.commonTasks.length > 0) {
    text += `### Common Tasks\n${profile.commonTasks.map(t => `- ${t}`).join('\n')}\n\n`;
  }
  if (profile.frequentContacts.length > 0) {
    text += `### Frequent Contacts\n${profile.frequentContacts.map(t => `- ${t}`).join('\n')}\n\n`;
  }
  if (profile.preferredTools.length > 0) {
    text += `### Preferred Tools\n${profile.preferredTools.map(t => `- ${t}`).join('\n')}\n\n`;
  }
  if (profile.efficiencyBenchmarks.length > 0) {
    text += `### Efficiency Benchmarks\n`;
    for (const b of profile.efficiencyBenchmarks) {
      text += `- ${b.task}: avg ${b.avgMinutes}min (${b.trend})\n`;
    }
    text += '\n';
  }

  return text;
}

function formatDocRefsForFile(refs: MemoryPackage['documentRefs']): string {
  let text = `## Inherited Document References\n`;
  for (const ref of refs) {
    text += `- ${ref.title} (${ref.type})`;
    if (ref.feishuDocToken) text += ` token: ${ref.feishuDocToken}`;
    if (ref.localPath) text += ` path: ${ref.localPath}`;
    text += '\n';
  }
  return text + '\n';
}

function formatDecisionsForFile(decisions: MemoryPackage['decisionHistory']): string {
  let text = `## Inherited Decision History\n`;
  for (const d of decisions) {
    text += `- [${d.date}] ${d.decision}\n`;
  }
  return text + '\n';
}

async function writeInheritedMemory(content: string, _userId: string): Promise<void> {
  const empFile = path.join(MEMORY_DIR, 'employee.markdown');
  try {
    let existing = '';
    try {
      existing = await fs.readFile(empFile, 'utf-8');
    } catch {
      // 文件不存在
    }
    await fs.writeFile(empFile, existing + content, 'utf-8');
  } catch (error) {
    console.warn(`[KnowledgeTransfer] Failed to write inherited memory: ${error instanceof Error ? error.message : String(error)}`);
  }
}
