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
  lastCapturedAt?: string;
  toolEvents: number;
  agentEvents: number;
  sessionEvents: number;
  knowledgeRecords: number;
  deduplicatedKnowledge: number;
  knowledgeByType: Partial<Record<CapturedKnowledgeType, number>>;
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
  | 'preference'
  | 'fact';

export type CapturedKnowledgeSource =
  | 'after_agent'
  | 'worklog'
  | 'session'
  | 'user';

export interface CapturedKnowledgeRecord {
  version: 1;
  id: string;
  contentHash: string;
  type: CapturedKnowledgeType;
  title: string;
  content: string;
  summary: string;
  keywords: string[];
  tags: string[];
  source: CapturedKnowledgeSource;
  confidence: number;
  sessionId?: string;
  projectRoot?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
  occurrences: number;
}

interface KnowledgeIndexEntry extends Omit<
  CapturedKnowledgeRecord,
  'version' | 'content'
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
        typeof entry.file !== 'string' ||
        path.basename(entry.file) !== entry.file
      )
        return [];
      const type = normalizeKnowledgeType(entry.type);
      if (!type) return [];
      return [
        {
          id: entry.id,
          contentHash: entry.contentHash,
          type,
          title: entry.title,
          summary:
            typeof entry.summary === 'string'
              ? entry.summary
              : compact(entry.title, 240),
          keywords: entry.keywords.filter(
            (keyword): keyword is string => typeof keyword === 'string',
          ),
          tags: Array.isArray(entry.tags)
            ? entry.tags.filter((tag): tag is string => typeof tag === 'string')
            : [],
          source: normalizeKnowledgeSource(entry.source) ?? 'after_agent',
          confidence:
            typeof entry.confidence === 'number'
              ? Math.min(1, Math.max(0, entry.confidence))
              : 0.7,
          sessionId:
            typeof entry.sessionId === 'string' ? entry.sessionId : undefined,
          projectRoot:
            typeof entry.projectRoot === 'string'
              ? entry.projectRoot
              : undefined,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          lastUsedAt:
            typeof entry.lastUsedAt === 'string'
              ? entry.lastUsedAt
              : undefined,
          useCount:
            typeof entry.useCount === 'number'
              ? Math.max(0, entry.useCount)
              : 0,
          occurrences:
            typeof entry.occurrences === 'number'
              ? Math.max(1, entry.occurrences)
              : 1,
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
    knowledgeByType: {},
  };
}

function normalizeKnowledgeType(
  value: unknown,
): CapturedKnowledgeType | undefined {
  return value === 'decision' ||
    value === 'bugfix' ||
    value === 'best_practice' ||
    value === 'preference' ||
    value === 'fact'
    ? value
    : undefined;
}

function normalizeKnowledgeSource(
  value: unknown,
): CapturedKnowledgeSource | undefined {
  return value === 'after_agent' ||
    value === 'worklog' ||
    value === 'session' ||
    value === 'user'
    ? value
    : undefined;
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

interface KnowledgeCandidate {
  type: CapturedKnowledgeType;
  title: string;
  content: string;
  source: CapturedKnowledgeSource;
  confidence: number;
}

function candidateSummary(content: string): string {
  return compact(content.replace(/^[^：:]{1,180}[：:]\s*/u, ''), 260);
}

function candidateTags(candidate: Pick<KnowledgeCandidate, 'title' | 'content' | 'type'>): string[] {
  return [
    candidate.type,
    ...knowledgeTokens(`${candidate.title}\n${candidate.content}`).slice(0, 8),
  ].slice(0, 10);
}

function extractKnowledgeCandidates(input: {
  requestText: string;
  responseText: string;
  source: CapturedKnowledgeSource;
}): KnowledgeCandidate[] {
  const request = taskTitle(input.requestText);
  const response = compact(input.responseText, 1_200);
  const candidates: KnowledgeCandidate[] = [];
  const rememberRequest = /(?:请记住|记住|以后|偏好|希望|习惯|always|prefer)/i.test(
    input.requestText,
  );
  if (rememberRequest) {
    candidates.push({
      type: 'preference',
      title: request,
      content: request,
      source: 'user',
      confidence: 0.92,
    });
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
        source: input.source,
        confidence: 0.86,
      });
    }
    if (/(决定|采用|选择|方案|改为|\bdecision\b|\bchose\b)/i.test(sentence)) {
      candidates.push({
        type: 'decision',
        title: request,
        content: `${request}：${sentence}`,
        source: input.source,
        confidence: 0.84,
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
        source: input.source,
        confidence: 0.78,
      });
    }
    if (/(确认|记录|事实|结论|原因是|\bfact\b|\bconfirmed\b)/i.test(sentence)) {
      candidates.push({
        type: 'fact',
        title: request,
        content: `${request}：${sentence}`,
        source: input.source,
        confidence: 0.72,
      });
    }
  }
  const unique = new Map<string, KnowledgeCandidate>();
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
      const knowledgeResult = input.success
        ? await this.storeKnowledgeCandidates(
            extractKnowledgeCandidates({
              requestText: input.action,
              responseText: [
                input.inputSummary,
                input.outputSummary,
              ].filter(Boolean).join('。'),
              source: 'worklog',
            }),
            input,
          )
        : await this.currentKnowledgeCount();
      await this.incrementStatus('toolEvents', knowledgeResult);
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
      const knowledgeResult = await this.storeKnowledgeCandidates(
        extractKnowledgeCandidates({
          requestText: input.requestText,
          responseText: input.responseText,
          source: 'after_agent',
        }),
        input,
      );
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
      const knowledgeResult = await this.storeSessionKnowledge(input);
      await this.incrementStatus('sessionEvents', knowledgeResult);
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
      if (knowledge.created > 0 || knowledge.deduplicated > 0) {
        status.lastCapturedAt = timestamp;
      }
      status.knowledgeByType = await this.knowledgeCountsByType();
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

  private async currentKnowledgeCount(): Promise<{
    created: number;
    deduplicated: number;
    total: number;
  }> {
    const index = await this.readKnowledgeIndex();
    return { created: 0, deduplicated: 0, total: index.records.length };
  }

  private async knowledgeCountsByType(): Promise<
    Partial<Record<CapturedKnowledgeType, number>>
  > {
    const index = await this.readKnowledgeIndex();
    const counts: Partial<Record<CapturedKnowledgeType, number>> = {};
    for (const record of index.records) {
      counts[record.type] = (counts[record.type] ?? 0) + 1;
    }
    return counts;
  }

  private async storeSessionKnowledge(
    input: SessionCaptureInput,
  ): Promise<{ created: number; deduplicated: number; total: number }> {
    const events = await this.readCaptureEvents();
    const relevant = events.filter((event) => {
      if (event.kind === 'session_end') return false;
      if (input.sessionId && event.sessionId !== input.sessionId) return false;
      if (input.projectRoot && event.projectRoot !== input.projectRoot) return false;
      return true;
    });
    const responseText = relevant
      .map((event) => {
        if (event.kind === 'agent') return event.responseText;
        if (event.kind === 'tool') {
          return [
            event.action,
            event.outputSummary,
          ].filter(Boolean).join('。');
        }
        return '';
      })
      .filter(Boolean)
      .slice(-12)
      .join('。');
    if (!responseText) return this.currentKnowledgeCount();
    return this.storeKnowledgeCandidates(
      extractKnowledgeCandidates({
        requestText: `会话结束：${input.reason}`,
        responseText,
        source: 'session',
      }),
      input,
    );
  }

  private async readCaptureEvents(): Promise<CaptureEvent[]> {
    try {
      const files = (await fs.readdir(this.eventsDir))
        .filter((file) => file.endsWith('.jsonl'))
        .sort()
        .slice(-7);
      const events: CaptureEvent[] = [];
      for (const file of files) {
        const lines = (await fs.readFile(path.join(this.eventsDir, file), 'utf8'))
          .split('\n')
          .filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as CaptureEvent;
            events.push(parsed);
          } catch {
            // Ignore a single corrupt event line; later records are still useful.
          }
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  private async storeKnowledgeCandidates(
    candidates: KnowledgeCandidate[],
    input: { sessionId?: string; projectRoot?: string },
  ): Promise<{ created: number; deduplicated: number; total: number }> {
    if (candidates.length === 0) {
      return this.currentKnowledgeCount();
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
            summary:
              existingRecord?.summary ?? existing.summary ?? compact(candidate.content, 260),
            content:
              existingRecord?.content ?? compact(candidate.content, 1_200),
            keywords: existing.keywords,
            tags: existing.tags,
            source: existing.source,
            confidence: Math.max(existing.confidence, candidate.confidence),
            sessionId: input.sessionId,
            projectRoot: existing.projectRoot,
            createdAt: existing.createdAt,
            updatedAt: timestamp,
            lastUsedAt: timestamp,
            useCount: existing.useCount + 1,
            occurrences: existing.occurrences + 1,
          }
        : {
            version: 1,
            id: `${candidate.type}-${contentHash.slice(0, 16)}`,
            contentHash,
            type: candidate.type,
            title: compact(candidate.title, 160),
            summary: candidateSummary(candidate.content),
            content: compact(candidate.content, 1_200),
            keywords: knowledgeTokens(
              `${candidate.title}\n${candidate.content}`,
            ),
            tags: candidateTags(candidate),
            source: candidate.source,
            confidence: candidate.confidence,
            sessionId: input.sessionId,
            projectRoot: input.projectRoot,
            createdAt: timestamp,
            updatedAt: timestamp,
            useCount: 0,
            occurrences: 1,
          };
      await this.writeJsonAtomic(path.join(this.knowledgeDir, file), record);
      const indexEntry: KnowledgeIndexEntry = {
        id: record.id,
        contentHash: record.contentHash,
        type: record.type,
        title: record.title,
        summary: record.summary,
        keywords: record.keywords,
        tags: record.tags,
        source: record.source,
        confidence: record.confidence,
        sessionId: record.sessionId,
        projectRoot: record.projectRoot,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        lastUsedAt: record.lastUsedAt,
        useCount: record.useCount,
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
  const byType = status.knowledgeByType ?? {};
  return [
    '自动知识沉淀状态',
    `工具事件 ${status.toolEvents} · 对话成果 ${status.agentEvents} · 会话收尾 ${status.sessionEvents}`,
    `可检索知识 ${status.knowledgeRecords} 条 · 内容去重 ${status.deduplicatedKnowledge} 次`,
    `按类型：decision ${byType.decision ?? 0} · bugfix ${byType.bugfix ?? 0} · best_practice ${byType.best_practice ?? 0} · preference ${byType.preference ?? 0} · fact ${byType.fact ?? 0}`,
    status.lastCapturedAt ? `最后沉淀：${status.lastCapturedAt}` : '尚无沉淀记录',
    status.lastEventAt ? `最后事件：${status.lastEventAt}` : '尚无事件记录',
    status.lastError ? `最近错误：${status.lastError}` : '运行状态：正常',
  ].join('\n');
}

let defaultPipeline: KnowledgeCapturePipeline | undefined;

export function getKnowledgeCapturePipeline(): KnowledgeCapturePipeline {
  defaultPipeline ??= new KnowledgeCapturePipeline();
  return defaultPipeline;
}
