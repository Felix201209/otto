/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  EnterpriseAccountSyncFile,
  EnterpriseAccountSyncPayload,
  EnterpriseAccountSyncScope,
  EnterpriseAccountSyncSnapshot,
} from './enterprise-client.js';

const ACCOUNT_SYNC_SCOPES: readonly EnterpriseAccountSyncScope[] = [
  'personal_memory',
  'worklog',
  'auto_skills',
];
const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MEMORY_SECTION_HEADER = '## Otto Added Memories';

export interface AccountDataSyncIdentity {
  serverUrl: string;
  accountId: string;
}

export interface AccountDataSyncRemote {
  listAccountSyncSnapshots(): Promise<EnterpriseAccountSyncSnapshot[]>;
  putAccountSyncSnapshot(input: {
    scope: EnterpriseAccountSyncScope;
    expectedVersion: number;
    payload: EnterpriseAccountSyncPayload;
    deviceId?: string | null;
  }): Promise<EnterpriseAccountSyncSnapshot>;
}

export interface AccountDataSyncSummary {
  identityKey: string;
  restoredFiles: number;
  uploadedScopes: EnterpriseAccountSyncScope[];
  conflictMerges: number;
  truncatedScopes: EnterpriseAccountSyncScope[];
}

interface AccountDataSyncState {
  schemaVersion: 1;
  activeIdentityKey: string;
  activatedAt: string;
}

interface ManagedFileCandidate {
  path: string;
  absolutePath: string;
  modifiedAtMs: number;
  size: number;
}

interface AccountDataSyncServiceOptions {
  userRoot?: string;
  worklogRoot?: string;
  now?: () => Date;
  deviceId?: string;
}

function defaultUserRoot(): string {
  return process.env['OTTO_USER_DIR']?.trim()
    || path.join(os.homedir(), '.otto-user');
}

function defaultWorklogRoot(userRoot: string): string {
  return process.env['OTTO_WORKLOG_DIR']?.trim()
    || path.join(userRoot, 'memory', 'worklog');
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function safeIdentityPart(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase();
}

export function accountDataSyncIdentityKey(identity: AccountDataSyncIdentity): string {
  return createHash('sha256')
    .update(`${safeIdentityPart(identity.serverUrl)}\0${identity.accountId.trim()}`, 'utf8')
    .digest('hex');
}

function isSafeRelativePath(value: string): boolean {
  return Boolean(value)
    && value.length <= 260
    && !value.includes('\\')
    && !value.startsWith('/')
    && value.split('/').every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

function normalizeManagedPath(
  scope: EnterpriseAccountSyncScope,
  value: string,
): string {
  if (scope !== 'personal_memory') return value;
  if (value === 'global.md') return 'memory/global.md';
  if (value.startsWith('sessions/')) return `memory/${value}`;
  return value;
}

function isPathAllowed(scope: EnterpriseAccountSyncScope, value: string): boolean {
  if (!isSafeRelativePath(value)) return false;
  if (scope === 'personal_memory') {
    return value === 'memory/global.md'
      || /^memory\/sessions\/[^/]{1,160}\.md$/u.test(value)
      || value === 'knowledge/entries.jsonl';
  }
  if (scope === 'worklog') {
    return /\.(?:jsonl|json|md)$/iu.test(value);
  }
  return /^auto-[^/]{1,160}\/(?:SKILL\.md|profile\.json)$/u.test(value);
}

function rootForScope(
  scope: EnterpriseAccountSyncScope,
  userRoot: string,
  worklogRoot: string,
): string {
  if (scope === 'personal_memory') return userRoot;
  if (scope === 'worklog') return worklogRoot;
  return path.join(userRoot, 'skills');
}

async function readDirectory(directory: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function addCandidate(
  candidates: ManagedFileCandidate[],
  root: string,
  relativePath: string,
): Promise<void> {
  const absolutePath = path.join(root, ...relativePath.split('/'));
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    candidates.push({
      path: relativePath,
      absolutePath,
      modifiedAtMs: Math.max(0, Math.floor(stat.mtimeMs)),
      size: stat.size,
    });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function walkWorklog(
  candidates: ManagedFileCandidate[],
  root: string,
  directory: string,
  prefix = '',
): Promise<void> {
  const entries = (await readDirectory(directory))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!isSafeRelativePath(relativePath)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkWorklog(candidates, root, absolutePath, relativePath);
    } else if (entry.isFile() && isPathAllowed('worklog', relativePath)) {
      await addCandidate(candidates, root, relativePath);
    }
  }
}

async function listManagedFiles(
  scope: EnterpriseAccountSyncScope,
  userRoot: string,
  worklogRoot: string,
): Promise<ManagedFileCandidate[]> {
  const root = rootForScope(scope, userRoot, worklogRoot);
  const candidates: ManagedFileCandidate[] = [];
  if (scope === 'personal_memory') {
    await addCandidate(candidates, root, 'memory/global.md');
    for (const entry of (await readDirectory(path.join(root, 'memory', 'sessions')))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = `memory/sessions/${entry.name}`;
      if (entry.isFile() && !entry.isSymbolicLink() && isPathAllowed(scope, relativePath)) {
        await addCandidate(candidates, root, relativePath);
      }
    }
    await addCandidate(candidates, root, 'knowledge/entries.jsonl');
  } else if (scope === 'worklog') {
    await walkWorklog(candidates, root, root);
  } else {
    for (const directory of (await readDirectory(root))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (!directory.isDirectory() || directory.isSymbolicLink() || !/^auto-.{1,160}$/u.test(directory.name)) {
        continue;
      }
      for (const fileName of ['SKILL.md', 'profile.json']) {
        const relativePath = `${directory.name}/${fileName}`;
        if (isPathAllowed(scope, relativePath)) {
          await addCandidate(candidates, root, relativePath);
        }
      }
    }
  }
  return candidates;
}

async function captureScope(
  scope: EnterpriseAccountSyncScope,
  userRoot: string,
  worklogRoot: string,
  generatedAt: string,
): Promise<EnterpriseAccountSyncPayload> {
  const candidates = (await listManagedFiles(scope, userRoot, worklogRoot))
    .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs || left.path.localeCompare(right.path));
  const files: EnterpriseAccountSyncFile[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const candidate of candidates) {
    if (files.length >= MAX_FILES || candidate.size > MAX_FILE_BYTES) {
      truncated = true;
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(candidate.absolutePath, 'utf8');
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    const nextTotal = totalBytes + bytes + Buffer.byteLength(candidate.path, 'utf8');
    if (bytes > MAX_FILE_BYTES || nextTotal > MAX_PAYLOAD_BYTES) {
      truncated = true;
      continue;
    }
    totalBytes = nextTotal;
    files.push({
      path: candidate.path,
      content,
      modifiedAtMs: candidate.modifiedAtMs,
      sha256: sha256(content),
    });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schemaVersion: 1,
    generatedAt,
    files,
    ...(truncated ? { truncated: true } : {}),
  };
}

function normalizePayload(
  scope: EnterpriseAccountSyncScope,
  payload: EnterpriseAccountSyncPayload,
): EnterpriseAccountSyncPayload {
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.files)) {
    throw new Error('account sync payload schema is unsupported');
  }
  const generatedAtMs = Date.parse(payload.generatedAt);
  if (!Number.isFinite(generatedAtMs)) throw new Error('account sync payload timestamp is invalid');
  if (payload.files.length > MAX_FILES) throw new Error('account sync payload contains too many files');

  let totalBytes = 0;
  const seen = new Set<string>();
  const files = payload.files.map((file): EnterpriseAccountSyncFile => {
    const relativePath = normalizeManagedPath(scope, file.path);
    if (!isPathAllowed(scope, relativePath) || seen.has(relativePath)) {
      throw new Error('account sync payload contains an invalid path');
    }
    seen.add(relativePath);
    const bytes = Buffer.byteLength(file.content, 'utf8');
    totalBytes += bytes + Buffer.byteLength(relativePath, 'utf8');
    if (bytes > MAX_FILE_BYTES || totalBytes > MAX_PAYLOAD_BYTES) {
      throw new Error('account sync payload exceeds the size limit');
    }
    const digest = sha256(file.content);
    if (digest !== file.sha256.toLowerCase()) {
      throw new Error('account sync payload checksum mismatch');
    }
    if (!Number.isFinite(file.modifiedAtMs) || file.modifiedAtMs < 0) {
      throw new Error('account sync payload file timestamp is invalid');
    }
    return {
      path: relativePath,
      content: file.content,
      modifiedAtMs: Math.floor(file.modifiedAtMs),
      sha256: digest,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));

  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAtMs).toISOString(),
    files,
    ...(payload.truncated ? { truncated: true } : {}),
  };
}

function payloadContentEqual(
  left: EnterpriseAccountSyncPayload,
  right: EnterpriseAccountSyncPayload,
): boolean {
  if (Boolean(left.truncated) !== Boolean(right.truncated) || left.files.length !== right.files.length) {
    return false;
  }
  return left.files.every((file, index) => {
    const other = right.files[index];
    return other?.path === file.path && other.sha256 === file.sha256;
  });
}

function extractMemoryFacts(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const headerIndex = trimmed.indexOf(MEMORY_SECTION_HEADER);
  const source = headerIndex >= 0
    ? (() => {
        const afterHeader = trimmed.slice(headerIndex + MEMORY_SECTION_HEADER.length);
        const nextSection = afterHeader.indexOf('\n## ');
        return nextSection >= 0 ? afterHeader.slice(0, nextSection) : afterHeader;
      })()
    : trimmed;
  return source.split(/\r?\n/u)
    .map((line) => line.trim().replace(/^[-*]\s*/u, '').trim())
    .filter((line) => Boolean(line) && !line.startsWith('#'));
}

function mergeMemoryContent(left: string, right: string): string {
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const fact of [...extractMemoryFacts(left), ...extractMemoryFacts(right)]) {
    const key = fact.replace(/\s+/gu, ' ').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    facts.push(fact);
  }
  return facts.length > 0
    ? `${MEMORY_SECTION_HEADER}\n${facts.map((fact) => `- ${fact}`).join('\n')}\n`
    : '';
}

interface JsonlLine {
  content: string;
  timestamp: number;
  order: number;
}

function jsonlTimestamp(content: string): number {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    for (const key of ['timestamp', 'createdAt', 'updatedAt', 'date']) {
      const parsed = Date.parse(String(value[key] ?? ''));
      if (Number.isFinite(parsed)) return parsed;
    }
  } catch {
    // Invalid historical lines are still preserved and sorted after dated entries.
  }
  return Number.POSITIVE_INFINITY;
}

function mergeJsonlContent(left: string, right: string): string {
  const lines: JsonlLine[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const content of [left, right]) {
    for (const rawLine of content.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line || seen.has(line)) continue;
      seen.add(line);
      lines.push({ content: line, timestamp: jsonlTimestamp(line), order: order++ });
    }
  }
  lines.sort((a, b) => a.timestamp - b.timestamp || a.order - b.order);
  return lines.length > 0 ? `${lines.map((line) => line.content).join('\n')}\n` : '';
}

function mergePendingSkillsContent(newer: string, older: string): string | null {
  try {
    const newestItems = JSON.parse(newer) as unknown;
    const oldestItems = JSON.parse(older) as unknown;
    if (!Array.isArray(newestItems) || !Array.isArray(oldestItems)) return null;
    const merged: unknown[] = [];
    const seen = new Set<string>();
    for (const item of [...newestItems, ...oldestItems]) {
      const record = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : null;
      const key = typeof record?.id === 'string'
        ? `id:${record.id}`
        : typeof record?.name === 'string'
          ? `name:${record.name}`
          : `value:${sha256(JSON.stringify(item))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return `${JSON.stringify(merged, null, 2)}\n`;
  } catch {
    return null;
  }
}

function newerFile(
  left: EnterpriseAccountSyncFile,
  right: EnterpriseAccountSyncFile,
): EnterpriseAccountSyncFile {
  if (left.modifiedAtMs !== right.modifiedAtMs) {
    return left.modifiedAtMs > right.modifiedAtMs ? left : right;
  }
  return left.sha256.localeCompare(right.sha256) >= 0 ? left : right;
}

function mergeFile(
  scope: EnterpriseAccountSyncScope,
  left: EnterpriseAccountSyncFile,
  right: EnterpriseAccountSyncFile,
): EnterpriseAccountSyncFile {
  if (left.sha256 === right.sha256) {
    return { ...left, modifiedAtMs: Math.max(left.modifiedAtMs, right.modifiedAtMs) };
  }
  let content: string | null = null;
  if (scope === 'personal_memory' && left.path === 'knowledge/entries.jsonl') {
    content = mergeJsonlContent(left.content, right.content);
  } else if (scope === 'personal_memory') {
    content = mergeMemoryContent(left.content, right.content);
  } else if (scope === 'worklog' && left.path.endsWith('.jsonl')) {
    content = mergeJsonlContent(left.content, right.content);
  } else if (scope === 'worklog' && left.path === 'pending_skills.json') {
    const newest = newerFile(left, right);
    const older = newest === left ? right : left;
    content = mergePendingSkillsContent(newest.content, older.content);
  }
  if (content === null) return newerFile(left, right);
  return {
    path: left.path,
    content,
    modifiedAtMs: Math.max(left.modifiedAtMs, right.modifiedAtMs),
    sha256: sha256(content),
  };
}

export function mergeAccountSyncPayloads(
  scope: EnterpriseAccountSyncScope,
  leftInput: EnterpriseAccountSyncPayload,
  rightInput: EnterpriseAccountSyncPayload,
  generatedAt = new Date().toISOString(),
): EnterpriseAccountSyncPayload {
  const left = normalizePayload(scope, leftInput);
  const right = normalizePayload(scope, rightInput);
  const leftByPath = new Map(left.files.map((file) => [file.path, file]));
  const rightByPath = new Map(right.files.map((file) => [file.path, file]));
  const paths = [...new Set([...leftByPath.keys(), ...rightByPath.keys()])].sort();
  const files = paths.map((filePath): EnterpriseAccountSyncFile => {
    const leftFile = leftByPath.get(filePath);
    const rightFile = rightByPath.get(filePath);
    if (!leftFile) return rightFile!;
    if (!rightFile) return leftFile;
    return mergeFile(scope, leftFile, rightFile);
  });
  return {
    schemaVersion: 1,
    generatedAt,
    files,
    ...(left.truncated || right.truncated ? { truncated: true } : {}),
  };
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
    if (process.platform !== 'win32') await fs.chmod(filePath, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function ensureSafeParent(root: string, relativePath: string): Promise<string> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  let current = root;
  for (const segment of relativePath.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`account sync target parent is unsafe: ${relativePath}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await fs.mkdir(current, { mode: 0o700 });
    }
  }
  const target = path.join(root, ...relativePath.split('/'));
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`account sync target is unsafe: ${relativePath}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return target;
}

async function clearManagedScope(
  scope: EnterpriseAccountSyncScope,
  userRoot: string,
  worklogRoot: string,
): Promise<void> {
  const files = await listManagedFiles(scope, userRoot, worklogRoot);
  await Promise.all(files.map((file) => fs.rm(file.absolutePath, { force: true })));
}

async function applyScopePayload(
  scope: EnterpriseAccountSyncScope,
  payloadInput: EnterpriseAccountSyncPayload,
  userRoot: string,
  worklogRoot: string,
  replaceManaged = false,
): Promise<void> {
  const payload = normalizePayload(scope, payloadInput);
  const root = rootForScope(scope, userRoot, worklogRoot);
  const targets = new Map<string, string>();
  for (const file of payload.files) {
    targets.set(file.path, await ensureSafeParent(root, file.path));
  }
  if (replaceManaged) {
    await clearManagedScope(scope, userRoot, worklogRoot);
  }
  for (const file of payload.files) {
    const target = targets.get(file.path)!;
    let nextFile = file;
    let currentDigest: string | null = null;
    if (!replaceManaged) {
      try {
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new Error(`account sync target is unsafe: ${file.path}`);
        }
        const currentContent = await fs.readFile(target, 'utf8');
        currentDigest = sha256(currentContent);
        if (currentDigest !== file.sha256) {
          nextFile = mergeFile(scope, {
            path: file.path,
            content: currentContent,
            modifiedAtMs: Math.max(0, Math.floor(stat.mtimeMs)),
            sha256: currentDigest,
          }, file);
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    if (currentDigest === nextFile.sha256) continue;
    await writeFileAtomic(target, nextFile.content);
    const modifiedAt = new Date(nextFile.modifiedAtMs);
    await fs.utimes(target, modifiedAt, modifiedAt).catch(() => undefined);
  }
}

export class AccountDataSyncService {
  private readonly userRoot: string;
  private readonly worklogRoot: string;
  private readonly syncRoot: string;
  private readonly now: () => Date;
  private readonly fixedDeviceId?: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: AccountDataSyncServiceOptions = {}) {
    this.userRoot = options.userRoot ?? defaultUserRoot();
    this.worklogRoot = options.worklogRoot ?? defaultWorklogRoot(this.userRoot);
    this.syncRoot = path.join(this.userRoot, 'account-sync');
    this.now = options.now ?? (() => new Date());
    this.fixedDeviceId = options.deviceId;
  }

  activate(identity: AccountDataSyncIdentity): Promise<string> {
    const identityKey = accountDataSyncIdentityKey(identity);
    const run = this.queue.then(async () => {
      await this.activateIdentity(identityKey);
      return identityKey;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  sync(
    remote: AccountDataSyncRemote,
    identity: AccountDataSyncIdentity,
  ): Promise<AccountDataSyncSummary> {
    const run = this.queue.then(() => this.syncInternal(remote, identity));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  erase(identity: AccountDataSyncIdentity): Promise<void> {
    const identityKey = accountDataSyncIdentityKey(identity);
    const run = this.queue.then(async () => {
      for (const scope of ACCOUNT_SYNC_SCOPES) {
        await clearManagedScope(scope, this.userRoot, this.worklogRoot);
      }
      await fs.rm(path.join(this.syncRoot, 'profiles', identityKey), {
        recursive: true,
        force: true,
      });
      const state = await readJson<AccountDataSyncState>(this.statePath());
      if (state?.schemaVersion === 1 && state.activeIdentityKey === identityKey) {
        await fs.rm(this.statePath(), { force: true });
      }
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private statePath(): string {
    return path.join(this.syncRoot, 'state.json');
  }

  private mirrorPath(identityKey: string, scope: EnterpriseAccountSyncScope): string {
    return path.join(this.syncRoot, 'profiles', identityKey, `${scope}.json`);
  }

  private async deviceId(): Promise<string> {
    if (this.fixedDeviceId) return this.fixedDeviceId;
    const filePath = path.join(this.syncRoot, 'device-id');
    try {
      const existing = (await fs.readFile(filePath, 'utf8')).trim();
      if (/^[a-zA-Z0-9._:-]{8,160}$/u.test(existing)) return existing;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const generated = randomUUID();
    await writeFileAtomic(filePath, `${generated}\n`);
    return generated;
  }

  private async readMirror(
    identityKey: string,
    scope: EnterpriseAccountSyncScope,
  ): Promise<EnterpriseAccountSyncPayload | null> {
    const payload = await readJson<EnterpriseAccountSyncPayload>(this.mirrorPath(identityKey, scope));
    if (!payload) return null;
    try {
      return normalizePayload(scope, payload);
    } catch {
      return null;
    }
  }

  private async saveMirror(
    identityKey: string,
    scope: EnterpriseAccountSyncScope,
    payload: EnterpriseAccountSyncPayload,
  ): Promise<void> {
    await writeJsonAtomic(this.mirrorPath(identityKey, scope), normalizePayload(scope, payload));
  }

  private async activateIdentity(identityKey: string): Promise<void> {
    const state = await readJson<AccountDataSyncState>(this.statePath());
    if (state?.schemaVersion === 1 && state.activeIdentityKey === identityKey) return;

    if (state?.schemaVersion === 1 && state.activeIdentityKey) {
      for (const scope of ACCOUNT_SYNC_SCOPES) {
        const current = await captureScope(
          scope,
          this.userRoot,
          this.worklogRoot,
          this.now().toISOString(),
        );
        await this.saveMirror(state.activeIdentityKey, scope, current);
      }
      await writeJsonAtomic(this.statePath(), {
        schemaVersion: 1,
        activeIdentityKey: identityKey,
        activatedAt: this.now().toISOString(),
      } satisfies AccountDataSyncState);
      for (const scope of ACCOUNT_SYNC_SCOPES) {
        const mirror = await this.readMirror(identityKey, scope);
        if (mirror) {
          await applyScopePayload(scope, mirror, this.userRoot, this.worklogRoot, true);
        } else {
          await clearManagedScope(scope, this.userRoot, this.worklogRoot);
        }
      }
      return;
    }

    for (const scope of ACCOUNT_SYNC_SCOPES) {
      const current = await captureScope(
        scope,
        this.userRoot,
        this.worklogRoot,
        this.now().toISOString(),
      );
      await this.saveMirror(identityKey, scope, current);
    }
    await writeJsonAtomic(this.statePath(), {
      schemaVersion: 1,
      activeIdentityKey: identityKey,
      activatedAt: this.now().toISOString(),
    } satisfies AccountDataSyncState);
  }

  private async syncInternal(
    remote: AccountDataSyncRemote,
    identity: AccountDataSyncIdentity,
  ): Promise<AccountDataSyncSummary> {
    const identityKey = accountDataSyncIdentityKey(identity);
    await this.activateIdentity(identityKey);
    const deviceId = await this.deviceId();
    const snapshots = await remote.listAccountSyncSnapshots();
    const remoteByScope = new Map(snapshots.map((snapshot) => [snapshot.scope, snapshot]));
    const summary: AccountDataSyncSummary = {
      identityKey,
      restoredFiles: 0,
      uploadedScopes: [],
      conflictMerges: 0,
      truncatedScopes: [],
    };
    const errors: unknown[] = [];

    for (const scope of ACCOUNT_SYNC_SCOPES) {
      try {
        let local = await captureScope(
          scope,
          this.userRoot,
          this.worklogRoot,
          this.now().toISOString(),
        );
        let remoteSnapshot = remoteByScope.get(scope);
        let merged = remoteSnapshot
          ? mergeAccountSyncPayloads(scope, local, remoteSnapshot.payload, this.now().toISOString())
          : local;
        if (!payloadContentEqual(local, merged)) {
          const localPaths = new Map(local.files.map((file) => [file.path, file.sha256]));
          summary.restoredFiles += merged.files.filter(
            (file) => localPaths.get(file.path) !== file.sha256,
          ).length;
          await applyScopePayload(scope, merged, this.userRoot, this.worklogRoot);
          local = await captureScope(
            scope,
            this.userRoot,
            this.worklogRoot,
            this.now().toISOString(),
          );
          merged = local;
        }

        if (!remoteSnapshot || !payloadContentEqual(remoteSnapshot.payload, merged)) {
          try {
            remoteSnapshot = await remote.putAccountSyncSnapshot({
              scope,
              expectedVersion: remoteSnapshot?.version ?? 0,
              payload: merged,
              deviceId,
            });
          } catch (error) {
            const latest = (await remote.listAccountSyncSnapshots())
              .find((snapshot) => snapshot.scope === scope);
            if (!latest || latest.version === remoteSnapshot?.version) throw error;
            summary.conflictMerges += 1;
            merged = mergeAccountSyncPayloads(
              scope,
              local,
              latest.payload,
              this.now().toISOString(),
            );
            if (!payloadContentEqual(local, merged)) {
              await applyScopePayload(scope, merged, this.userRoot, this.worklogRoot);
              local = await captureScope(
                scope,
                this.userRoot,
                this.worklogRoot,
                this.now().toISOString(),
              );
              merged = local;
            }
            remoteSnapshot = await remote.putAccountSyncSnapshot({
              scope,
              expectedVersion: latest.version,
              payload: merged,
              deviceId,
            });
          }
          summary.uploadedScopes.push(scope);
        }
        if (merged.truncated) summary.truncatedScopes.push(scope);
        await this.saveMirror(identityKey, scope, remoteSnapshot?.payload ?? merged);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, 'one or more account data scopes failed to synchronize');
    }
    return summary;
  }
}
