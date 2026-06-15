/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hermes 式记忆框架(分层记忆抽象)。
 *
 * 把现状(纯文件 append + 飞书会话隔离 + 去重 + 256KB 上限)抽象成可扩展的
 * MemoryProvider:三层 scope(global / project / session)各自有独立存储位置,
 * 通过统一的 load/save 接口读写,再由装配函数合并成给 prompt 用的字符串
 * (经 config.userMemory 既有注入链进入 prompt,不改 turn.ts 的控制流)。
 *
 * 全部向后兼容:project 层仍是项目根 OTTO.md,行为与既有 MemoryTool 完全一致;
 * 写入复用 MemoryTool 已有的串行写锁 + 去重 + 上限,不另起一套并发模型。
 */

import * as fs from 'fs/promises';
import {
  MemoryTool,
  getGlobalMemoryPath,
  getFeishuSessionMemoryPath,
  MEMORY_SECTION_HEADER,
} from '../tools/memoryTool.js';

/**
 * 记忆作用域:三层。
 * - `global`:跨项目、跨会话的用户级偏好(~/.otto-user/memory/global.md)。
 * - `project`:项目根 OTTO.md(保持现状,向后兼容)。
 * - `session`:单飞书会话维度(~/.otto-user/memory/sessions/<id>.md)。
 */
export type MemoryScope = 'global' | 'project' | 'session';

/** 定位某一层记忆所需的运行时上下文。 */
export interface MemoryScopeContext {
  /** 当前项目根目录,用于解析 project 层的 OTTO.md。 */
  readonly projectRoot: string;
  /** 当前会话标识(飞书 chatId),用于解析 session 层文件;无则跳过 session 层。 */
  readonly sessionId?: string;
}

/**
 * 记忆 Provider 抽象(借鉴 Hermes MemoryProvider,TS 化、精简到两个核心动作)。
 *
 * - `load(scope)` → 返回该层记忆的原始文本(不存在则空串)。
 * - `save(scope, fact)` → 把一条事实追加进该层记忆(幂等去重 + 上限保护)。
 */
export interface MemoryProvider {
  /** Provider 名称(诊断/日志用)。 */
  readonly name: string;
  /** 读取指定 scope 的记忆文本。文件缺失返回空串,绝不抛 ENOENT。 */
  load(scope: MemoryScope): Promise<string>;
  /** 向指定 scope 追加一条事实。复用底层串行写锁,保证并发安全。 */
  save(scope: MemoryScope, fact: string): Promise<void>;
}

/** Provider 写文件用的 fs 适配器(可注入,便于测试)。 */
export interface MemoryFsAdapter {
  readFile: (path: string, encoding: 'utf-8') => Promise<string>;
  writeFile: (path: string, data: string, encoding: 'utf-8') => Promise<void>;
  mkdir: (
    path: string,
    options: { recursive: boolean },
  ) => Promise<string | undefined>;
}

const DEFAULT_FS_ADAPTER: MemoryFsAdapter = {
  readFile: fs.readFile,
  writeFile: fs.writeFile,
  mkdir: fs.mkdir,
};

/**
 * 把一个 scope 解析为其后端记忆文件的绝对路径。
 * session 层缺 sessionId 时返回 null(表示该层不可用,跳过而非报错)。
 */
function resolveScopePath(
  scope: MemoryScope,
  ctx: MemoryScopeContext,
): string | null {
  switch (scope) {
    case 'global':
      return getGlobalMemoryPath();
    case 'project':
      // 保持现状:项目根 OTTO.md。与既有 getProjectMemoryFilePath 行为一致。
      return `${ctx.projectRoot.replace(/[/\\]+$/, '')}/OTTO.md`;
    case 'session':
      return ctx.sessionId ? getFeishuSessionMemoryPath(ctx.sessionId) : null;
    default:
      return null;
  }
}

/**
 * 基于文件的 MemoryProvider:三层全部落地为 Markdown 文件。
 *
 * 写入直接委托 MemoryTool.performAddMemoryEntry —— 复用其进程内按文件串行的
 * 写锁(memoryWriteChains)+ 同事实去重 + MAX_MEMORY_FILE_SIZE 上限,
 * 不重复造并发模型。读取做空文件/缺失文件的安全兜底。
 */
export class FileMemoryProvider implements MemoryProvider {
  readonly name = 'file';

  constructor(
    private readonly ctx: MemoryScopeContext,
    private readonly fsAdapter: MemoryFsAdapter = DEFAULT_FS_ADAPTER,
  ) {}

  async load(scope: MemoryScope): Promise<string> {
    const filePath = resolveScopePath(scope, this.ctx);
    if (!filePath) {
      return '';
    }
    try {
      const content = await this.fsAdapter.readFile(filePath, 'utf-8');
      return content ?? '';
    } catch {
      // 文件不存在/不可读:视为该层暂无记忆,返回空串。
      return '';
    }
  }

  async save(scope: MemoryScope, fact: string): Promise<void> {
    const trimmed = (fact ?? '').trim();
    if (trimmed.length === 0) {
      return;
    }
    const filePath = resolveScopePath(scope, this.ctx);
    if (!filePath) {
      // session 层无 sessionId 等情况:静默跳过,不阻断主流程。
      return;
    }
    // 复用既有串行写锁 + 去重 + 上限。
    await MemoryTool.performAddMemoryEntry(trimmed, filePath, this.fsAdapter);
  }
}

/** 装配选项。 */
export interface AssembleMemoryOptions {
  /**
   * 合并顺序中包含哪些 scope。默认 ['global', 'project', 'session'],
   * 即:全局偏好垫底、项目记忆居中、会话记忆最近(越靠后越贴近当下)。
   */
  readonly scopes?: readonly MemoryScope[];
}

const DEFAULT_SCOPE_ORDER: readonly MemoryScope[] = [
  'global',
  'project',
  'session',
];

/** 每层在装配输出里的人类可读标签。 */
const SCOPE_LABEL: Record<MemoryScope, string> = {
  global: 'Global Memory',
  project: 'Project Memory',
  session: 'Session Memory',
};

/**
 * 从一条记忆文本里抽出 MEMORY_SECTION_HEADER 段落下的事实(只保留 "- " 列表项),
 * 用于装配时聚焦"用户/会话沉淀的事实",而非整篇上下文文件。
 * 若文本里没有该段落头,则原样返回 trim 后的全文(向后兼容裸记忆文件)。
 */
function extractMemorySection(raw: string): string {
  const content = (raw ?? '').trim();
  if (content.length === 0) {
    return '';
  }
  const headerIndex = content.indexOf(MEMORY_SECTION_HEADER);
  if (headerIndex === -1) {
    return content;
  }
  const start = headerIndex + MEMORY_SECTION_HEADER.length;
  let end = content.indexOf('\n## ', start);
  if (end === -1) {
    end = content.length;
  }
  return content.substring(start, end).trim();
}

/**
 * 装配函数:把三层记忆合并成一段给 prompt 用的字符串。
 *
 * 设计意图:供 loadServerHierarchicalMemory / loadFeishuSessionMemory 这条
 * 既有通路调用,产出物直接喂给 config.setUserMemory(...),从而经现有
 * config.userMemory 注入链进入 prompt —— 不触碰 turn.ts/feishuCommand.ts 控制流。
 *
 * 输出形如:
 *   --- Global Memory ---
 *   - 用户偏好简洁回复
 *   --- Project Memory ---
 *   - 该项目用 pnpm
 *   --- Session Memory ---
 *   - 本会话聚焦记忆框架
 *
 * 任一层为空则跳过该层;全部为空返回空串(调用方可据此决定是否注入)。
 */
export async function assembleLayeredMemory(
  provider: MemoryProvider,
  options: AssembleMemoryOptions = {},
): Promise<string> {
  const scopes = options.scopes ?? DEFAULT_SCOPE_ORDER;
  const blocks: string[] = [];

  for (const scope of scopes) {
    let raw = '';
    try {
      raw = await provider.load(scope);
    } catch {
      // 单层读取失败不应拖垮整体装配;跳过该层。
      raw = '';
    }
    const section = extractMemorySection(raw);
    if (section.length === 0) {
      continue;
    }
    blocks.push(`--- ${SCOPE_LABEL[scope]} ---\n${section}`);
  }

  return blocks.join('\n\n');
}

/**
 * 便捷装配:直接给上下文(projectRoot + 可选 sessionId),内部用 FileMemoryProvider
 * 装配三层记忆。供既有记忆加载函数一行接入。
 */
export async function assembleFileLayeredMemory(
  ctx: MemoryScopeContext,
  options: AssembleMemoryOptions = {},
): Promise<string> {
  const provider = new FileMemoryProvider(ctx);
  return assembleLayeredMemory(provider, options);
}
