/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Durable, privacy-bounded lifecycle capture for Otto. The pipeline is called
 * from real tool/agent/session entry points; it does not depend on a model
 * deciding to call a memory tool.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getWorkLogger, type WorkLogEntry } from './workLog.js';
import { redactSensitiveText } from '../utils/redaction.js';

export interface KnowledgeCaptureStatus {
  version: 1;
  updatedAt?: string;
  lastEventAt?: string;
  toolEvents: number;
  agentEvents: number;
  sessionEvents: number;
  knowledgeRecords: number;
  deduplicatedKnowledge: number;
  lastError?: string;
}

interface WorkLoggerLike {
  log(entry: Omit<WorkLogEntry, 'timestamp'>): Promise<void>;
}

export interface KnowledgeCapturePipelineOptions {
  rootDir?: string;
  now?: () => Date;
  workLogger?: WorkLoggerLike;
  maxPromptIds?: number;
  maxKnowledgeRecords?: number;
}

export interface ToolCaptureInput {
  sessionId?: string;
  projectRoot?: string;
  toolName: string;
  action: string;
  success: boolean;
  inputSummary?: string;
  outputSummary?: string;
  durationMs?: number;
}

export interface AgentCaptureInput {
  promptId: string;
  sessionId?: string;
  projectRoot?: string;
  requestText: string;
  responseText: string;
  durationMs?: number;
}

export interface SessionCaptureInput {
  sessionId?: string;
  projectRoot?: string;
  reason: string;
}

type CaptureEvent =
  | ({ kind: 'tool' } & ToolCaptureInput)
  | ({ kind: 'agent' } & AgentCaptureInput)
  | ({ kind: 'session_end' } & SessionCaptureInput);

export type CapturedKnowledgeType =
  | 'decision'
  | 'bugfix'
  | 'best_practice'
  | 'preference';

export interface CapturedKnowledgeRecord {
  version: 1;
  id: string;
  contentHash: string;
  type: CapturedKnowledgeType;
  title: string;
  content: string;
  keywords: string[];
  source: 'after_agent';
  sessionId?: string;
  projectRoot?: string;
  createdAt: string;
  updatedAt: string;
  occurrences: number;
}

interface KnowledgeIndexEntry extends Omit<
  CapturedKnowledgeRecord,
  'version' | 'source' | 'content'
> {
  file: string;
}

interface KnowledgeIndex {
  version: 1;
  updatedAt?: string;
  records: KnowledgeIndexEntry[];
}

function normalizeKnowledgeIndex(value: unknown): KnowledgeIndex {
  const raw =
    value && typeof value === 'object'
      ? (value as Partial<KnowledgeIndex>)
      : {};
  const records = Array.isArray(raw.records) ? raw.records : [];
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    records: records.flatMap((candidate) => {
      const entry = candidate as Partial<KnowledgeIndexEntry>;
      if (
        typeof entry.id !== 'string' ||
        typeof entry.contentHash !== 'string' ||
        typeof entry.type !== 'string' ||
        typeof entry.title !== 'string' ||
        !Array.isArray(entry.keywords) ||
        typeof entry.createdAt !== 'string' ||
        typeof entry.updatedAt !== 'string' ||
        typeof entry.occurrences !== 'number' ||
        typeof entry.file !== 'string' ||
        path.basename(entry.file) !== entry.file
      )
        return [];
      return [
        {
          id: entry.id,
          contentHash: entry.contentHash,
          type: entry.type as CapturedKnowledgeType,
          title: entry.title,
          keywords: entry.keywords.filter(
            (keyword): keyword is string => typeof keyword === 'string',
          ),
          sessionId:
            typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
          projectRoot:
            typeof entry.projectRoot === 'string'
              ? entry.projectRoot
              : undefined,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          occurrences: entry.occurrences,
          file: entry.file,
        },
      ];
    }),
  };
}

export interface KnowledgeSearchOptions {
  projectRoot?: string;
  limit?: number;
}

export interface KnowledgeSearchResult {
  record: CapturedKnowledgeRecord;
  score: number;
}

function resolveDefaultRoot(): string {
  const userDir = process.env['OTTO_USER_DIR']?.trim();
  if (userDir) return path.join(userDir, 'memory', 'knowledge-capture');
  if (process.env['NODE_ENV'] === 'test' || process.env['VITEST']) {
    return path.join(
      os.tmpdir(),
      'otto-knowledge-capture-tests',
      String(process.pid),
    );
  }
  return path.join(os.homedir(), '.otto-user', 'memory', 'knowledge-capture');
}

function compact(value: string | undefined, maxLength: number): string {
  const normalized = redactSensitiveText(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
    : normalized;
}

function taskTitle(requestText: string): string {
  const currentRequest = requestText.includes('--- Current user request ---')
    ? (requestText.split('--- Current user request ---').at(-1) ?? requestText)
    : requestText;
  return compact(currentRequest, 120) || '已完成一轮 Otto 工作';
}

function emptyStatus(): KnowledgeCaptureStatus {
  return {
    version: 1,
    toolEvents: 0,
    agentEvents: 0,
    sessionEvents: 0,
    knowledgeRecords: 0,
    deduplicatedKnowledge: 0,
  };
}

function knowledgeTokens(value: string): string[] {
  const normalized = value.toLowerCase();
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/[\p{L}\p{N}_-]{2,}/gu)) {
    const token = match[0];
    tokens.add(token);
    if (/\p{Script=Han}/u.test(token)) {
      for (let index = 0; index < token.length - 1; index += 1) {
        tokens.add(token.slice(index, index + 2));
      }
    }
  }
  return [...tokens].slice(0, 80);
}

function extractKnowledgeCandidates(input: AgentCaptureInput): Array<{
  type: CapturedKnowledgeType;
  title: string;
  content: string;
}> {
  const request = taskTitle(input.requestText);
  const response = compact(input.responseText, 1_200);
  const candidates: Array<{
    type: CapturedKnowledgeType;
    title: string;
    content: string;
  }> = [];
  if (/(?:请记住|以后|偏好|希望|习惯|always|prefer)/i.test(input.requestText)) {
    candidates.push({ type: 'preference', title: request, content: request });
  }
  const sentences = response
    .split(/(?<=[。！？.!?])\s*/u)
    .map((item) => item.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (
      /(已?修复|解决|错误|故障|崩溃|\bbug\b|\bfix(?:ed)?\b)/i.test(sentence)
    ) {
      candidates.push({
        type: 'bugfix',
        title: request,
        content: `${request}：${sentence}`,
      });
    }
    if (/(决定|采用|选择|方案|改为|\bdecision\b|\bchose\b)/i.test(sentence)) {
      candidates.push({
        type: 'decision',
        title: request,
        content: `${request}：${sentence}`,
      });
    }
    if (
      /(验证|测试|必须|应当|避免|防止|最佳|流程|\bverify|\btest|best practice)/i.test(
        sentence,
      )
    ) {
      candidates.push({
        type: 'best_practice',
        title: request,
        content: `${request}：${sentence}`,
      });
    }
  }
  const unique = new Map<
    string,
    { type: CapturedKnowledgeType; title: string; content: string }
  >();
  for (const candidate of candidates) {
    unique.set(
      `${candidate.type}\0${candidate.content.toLowerCase()}`,
      candidate,
    );
  }
  return [...unique.values()].slice(0, 6);
}

export class KnowledgeCapturePipeline {
  private readonly rootDir: string;
  private readonly eventsDir: string;
  private readonly statusPath: string;
  private readonly knowledgeDir: string;
  private readonly knowledgeIndexPath: string;
  private readonly legacyKnowledgeIndexPath: string;
  private readonly now: () => Date;
  private readonly workLogger: WorkLoggerLike;
  private readonly maxPromptIds: number;
  private readonly maxKnowledgeRecords: number;
  private readonly capturedPromptIds = new Set<string>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: KnowledgeCapturePipelineOptions = {}) {
    this.rootDir = options.rootDir ?? resolveDefaultRoot();
    this.eventsDir = path.join(this.rootDir, 'events');
    this.statusPath = path.join(this.rootDir, 'status.json');
    this.knowledgeDir = path.join(this.rootDir, 'knowledge');
    this.knowledgeIndexPath = path.join(this.rootDir, 'memory-index.json');
    this.legacyKnowledgeIndexPath = path.join(this.knowledgeDir, 'index.json');
    this.now = options.now ?? (() => new Date());
    this.workLogger = options.workLogger ?? getWorkLogger();
    this.maxPromptIds = Math.max(1, options.maxPromptIds ?? 2_000);
    this.maxKnowledgeRecords = Math.max(
      1,
      options.maxKnowledgeRecords ?? 5_000,
    );
  }

  async captureToolExecution(input: ToolCaptureInput): Promise<void> {
    // Enterprise messages can contain private employee conversations and must
    // stay in their dedicated transport/database boundary, never in memory.
    if (input.toolName === 'enterprise_collaboration') return;
    await this.enqueue(async () => {
      await this.appendEvent({
        kind: 'tool',
        ...input,
        action: compact(input.action, 240),
        inputSummary: compact(input.inputSummary, 600),
        outputSummary: compact(input.outputSummary, 600),
      });
      await this.incrementStatus('toolEvents');
    });
  }

  async captureAfterAgent(input: AgentCaptureInput): Promise<void> {
    const promptId = input.promptId.trim();
    const responseText = compact(input.responseText, 1_200);
    if (!promptId || !responseText || this.capturedPromptIds.has(promptId))
      return;
    this.capturedPromptIds.add(promptId);
    while (this.capturedPromptIds.size > this.maxPromptIds) {
      const oldest = this.capturedPromptIds.values().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.capturedPromptIds.delete(oldest);
    }

    await this.enqueue(async () => {
      const title = taskTitle(input.requestText);
      const userInput = compact(input.requestText, 800);
      await this.workLogger.log({
        toolName: 'otto_work_result',
        action: title,
        category: 'other',
        success: true,
        durationMs: input.durationMs,
        details: responseText,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        entryType: 'work_result',
        taskTitle: title,
        userInput,
      });
      const knowledgeResult = await this.storeKnowledge(input);
      await this.appendEvent({
        kind: 'agent',
        ...input,
        requestText: userInput,
        responseText,
      });
      await this.incrementStatus('agentEvents', knowledgeResult);
    }).catch((error) => {
      this.capturedPromptIds.delete(promptId);
      throw error;
    });
  }

  async captureSessionEnd(input: SessionCaptureInput): Promise<void> {
    await this.enqueue(async () => {
      await this.appendEvent({
        kind: 'session_end',
        ...input,
        reason: compact(input.reason, 120),
      });
      await this.incrementStatus('sessionEvents');
    });
  }

  async getStatus(): Promise<KnowledgeCaptureStatus> {
    await this.writeQueue.catch(() => undefined);
    try {
      const parsed = JSON.parse(
        await fs.readFile(this.statusPath, 'utf8'),
      ) as KnowledgeCaptureStatus;
      return { ...emptyStatus(), ...parsed, version: 1 };
    } catch {
      return emptyStatus();
    }
  }

  async searchKnowledge(
    query: string,
    options: KnowledgeSearchOptions = {},
  ): Promise<KnowledgeSearchResult[]> {
    await this.writeQueue.catch(() => undefined);
    const queryTokens = new Set(knowledgeTokens(query));
    if (queryTokens.size === 0) return [];
    const index = await this.readKnowledgeIndex();
    const expectedProject = options.projectRoot
      ? path.resolve(options.projectRoot).toLowerCase()
      : undefined;
    const ranked = index.records
      .map((entry) => {
        const recordTokens = new Set(entry.keywords);
        let overlap = 0;
        for (const token of queryTokens)
          if (recordTokens.has(token)) overlap += 1;
        const projectBoost =
          expectedProject &&
          entry.projectRoot &&
          path.resolve(entry.projectRoot).toLowerCase() === expectedProject
            ? 1.35
            : 1;
        const occurrenceBoost =
          1 + Math.min(0.3, Math.max(0, entry.occurrences - 1) * 0.05);
        return {
          entry,
          score:
            (overlap /
              Math.max(1, Math.sqrt(queryTokens.size * recordTokens.size))) *
            projectBoost *
            occurrenceBoost,
        };
      })
      .filter(({ score }) => score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.updatedAt.localeCompare(a.entry.updatedAt),
      )
      .slice(0, Math.max(1, options.limit ?? 5));

    const results: KnowledgeSearchResult[] = [];
    for (const { entry, score } of ranked) {
      try {
        const record = JSON.parse(
          await fs.readFile(path.join(this.knowledgeDir, entry.file), 'utf8'),
        ) as CapturedKnowledgeRecord;
        results.push({ record, score });
      } catch {
        // A missing individual record must not make all history retrieval fail.
      }
    }
    return results;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.writeQueue.then(operation, operation);
    this.writeQueue = current.catch(async (error) => {
      await this.writeErrorStatus(error).catch(() => undefined);
    });
    return current;
  }

  private async ensureDirs(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.eventsDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.knowledgeDir, { recursive: true, mode: 0o700 }),
    ]);
    if (process.platform !== 'win32') {
      await fs.chmod(this.rootDir, 0o700).catch(() => undefined);
      await fs.chmod(this.eventsDir, 0o700).catch(() => undefined);
      await fs.chmod(this.knowledgeDir, 0o700).catch(() => undefined);
    }
  }

  private async appendEvent(event: CaptureEvent): Promise<void> {
    await this.ensureDirs();
    const timestamp = this.now().toISOString();
    const eventPath = path.join(
      this.eventsDir,
      `${timestamp.slice(0, 10)}.jsonl`,
    );
    const line = `${JSON.stringify({ version: 1, timestamp, ...event })}\n`;
    await fs.appendFile(eventPath, line, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32')
      await fs.chmod(eventPath, 0o600).catch(() => undefined);
  }

  private async incrementStatus(
    field: 'toolEvents' | 'agentEvents' | 'sessionEvents',
    knowledge?: { created: number; deduplicated: number; total: number },
  ): Promise<void> {
    const status = await this.readStatusUnsafe();
    const timestamp = this.now().toISOString();
    status[field] += 1;
    if (knowledge) {
      status.knowledgeRecords = knowledge.total;
      status.deduplicatedKnowledge += knowledge.deduplicated;
    }
    status.updatedAt = timestamp;
    status.lastEventAt = timestamp;
    delete status.lastError;
    await this.writeStatus(status);
  }

  private async readStatusUnsafe(): Promise<KnowledgeCaptureStatus> {
    try {
      return {
        ...emptyStatus(),
        ...JSON.parse(await fs.readFile(this.statusPath, 'utf8')),
      };
    } catch {
      return emptyStatus();
    }
  }

  private async writeStatus(status: KnowledgeCaptureStatus): Promise<void> {
    await this.ensureDirs();
    const tempPath = `${this.statusPath}.tmp-${process.pid}`;
    await fs.writeFile(tempPath, JSON.stringify(status, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tempPath, this.statusPath);
    if (process.platform !== 'win32')
      await fs.chmod(this.statusPath, 0o600).catch(() => undefined);
  }

  private async writeErrorStatus(error: unknown): Promise<void> {
    const status = await this.readStatusUnsafe();
    status.updatedAt = this.now().toISOString();
    status.lastError = compact(
      error instanceof Error ? error.message : String(error),
      300,
    );
    await this.writeStatus(status);
  }

  private async readKnowledgeIndex(): Promise<KnowledgeIndex> {
    for (const indexPath of [
      this.knowledgeIndexPath,
      this.legacyKnowledgeIndexPath,
    ]) {
      try {
        const index = normalizeKnowledgeIndex(
          JSON.parse(await fs.readFile(indexPath, 'utf8')),
        );
        if (index.records.length > 0 || indexPath === this.knowledgeIndexPath)
          return index;
      } catch {
        // Try the legacy path before treating the index as empty.
      }
    }
    return { version: 1, records: [] };
  }

  private async storeKnowledge(
    input: AgentCaptureInput,
  ): Promise<{ created: number; deduplicated: number; total: number }> {
    const candidates = extractKnowledgeCandidates(input);
    if (candidates.length === 0) {
      const index = await this.readKnowledgeIndex();
      return { created: 0, deduplicated: 0, total: index.records.length };
    }
    await this.ensureDirs();
    const index = await this.readKnowledgeIndex();
    let created = 0;
    let deduplicated = 0;
    for (const candidate of candidates) {
      const normalized = `${candidate.type}\n${input.projectRoot ?? ''}\n${candidate.content.toLowerCase().replace(/\s+/g, ' ').trim()}`;
      const contentHash = createHash('sha256').update(normalized).digest('hex');
      const existing = index.records.find(
        (record) => record.contentHash === contentHash,
      );
      const timestamp = this.now().toISOString();
      const file = `${candidate.type}-${contentHash.slice(0, 24)}.json`;
      const existingRecord = existing
        ? await this.readKnowledgeRecord(existing.file)
        : undefined;
      const record: CapturedKnowledgeRecord = existing
        ? {
            version: 1,
            id: existing.id,
            contentHash,
            type: existing.type,
            title: existing.title,
            content:
              existingRecord?.content ?? compact(candidate.content, 1_200),
            keywords: existing.keywords,
            source: 'after_agent',
            sessionId: input.sessionId,
            projectRoot: existing.projectRoot,
            createdAt: existing.createdAt,
            updatedAt: timestamp,
            occurrences: existing.occurrences + 1,
          }
        : {
            version: 1,
            id: `${candidate.type}-${contentHash.slice(0, 16)}`,
            contentHash,
            type: candidate.type,
            title: compact(candidate.title, 160),
            content: compact(candidate.content, 1_200),
            keywords: knowledgeTokens(
              `${candidate.title}\n${candidate.content}`,
            ),
            source: 'after_agent',
            sessionId: input.sessionId,
            projectRoot: input.projectRoot,
            createdAt: timestamp,
            updatedAt: timestamp,
            occurrences: 1,
          };
      await this.writeJsonAtomic(path.join(this.knowledgeDir, file), record);
      const indexEntry: KnowledgeIndexEntry = {
        id: record.id,
        contentHash: record.contentHash,
        type: record.type,
        title: record.title,
        keywords: record.keywords,
        sessionId: record.sessionId,
        projectRoot: record.projectRoot,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        occurrences: record.occurrences,
        file,
      };
      if (existing) {
        index.records[index.records.indexOf(existing)] = indexEntry;
        deduplicated += 1;
      } else {
        index.records.push(indexEntry);
        created += 1;
      }
    }
    index.records.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    const evicted = index.records.splice(this.maxKnowledgeRecords);
    await Promise.all(
      evicted.map((entry) =>
        fs
          .rm(path.join(this.knowledgeDir, entry.file), { force: true })
          .catch(() => undefined),
      ),
    );
    index.updatedAt = this.now().toISOString();
    await this.writeJsonAtomic(this.knowledgeIndexPath, index);
    return { created, deduplicated, total: index.records.length };
  }

  private async readKnowledgeRecord(
    file: string,
  ): Promise<CapturedKnowledgeRecord | undefined> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.knowledgeDir, file), 'utf8'),
      ) as CapturedKnowledgeRecord;
    } catch {
      return undefined;
    }
  }

  private async writeJsonAtomic(
    filePath: string,
    value: unknown,
  ): Promise<void> {
    const tempPath = `${filePath}.tmp-${process.pid}`;
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tempPath, filePath);
    if (process.platform !== 'win32')
      await fs.chmod(filePath, 0o600).catch(() => undefined);
  }
}

export function formatKnowledgeCaptureStatus(
  status: KnowledgeCaptureStatus,
): string {
  return [
    '自动知识沉淀状态',
    `工具事件 ${status.toolEvents} · 对话成果 ${status.agentEvents} · 会话收尾 ${status.sessionEvents}`,
    `可检索知识 ${status.knowledgeRecords} 条 · 内容去重 ${status.deduplicatedKnowledge} 次`,
    status.lastEventAt ? `最后沉淀：${status.lastEventAt}` : '尚无沉淀记录',
    status.lastError ? `最近错误：${status.lastError}` : '运行状态：正常',
  ].join('\n');
}

let defaultPipeline: KnowledgeCapturePipeline | undefined;

export function getKnowledgeCapturePipeline(): KnowledgeCapturePipeline {
  defaultPipeline ??= new KnowledgeCapturePipeline();
  return defaultPipeline;
}
