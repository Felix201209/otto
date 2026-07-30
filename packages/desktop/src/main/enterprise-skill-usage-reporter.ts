/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface EnterpriseSkillUsageIdentity {
  serverUrl: string;
  accountId: string;
}

export interface EnterpriseSkillUsageReporterOptions {
  skillsRoot(): string;
  usageFile(): string;
  stateFile(): string;
  identity(): EnterpriseSkillUsageIdentity | null;
  report(skillId: string, success: boolean, eventId: string): Promise<void>;
  maxEventsPerPoll?: number;
}

interface ReporterState {
  schemaVersion: 1;
  identities: Record<string, string[]>;
}

interface LocalSkillUsage {
  skillName: string;
  success: boolean;
}

const MAX_IDENTITIES = 20;
const MAX_EVENT_IDS_PER_IDENTITY = 2_000;

function identityKey(identity: EnterpriseSkillUsageIdentity): string {
  return createHash('sha256')
    .update(`${identity.serverUrl.trim().replace(/\/+$/u, '')}\0${identity.accountId}`, 'utf8')
    .digest('hex');
}

function eventId(identity: EnterpriseSkillUsageIdentity, rawLine: string): string {
  return createHash('sha256')
    .update(`${identity.serverUrl.trim().replace(/\/+$/u, '')}\0${identity.accountId}\0${rawLine}`, 'utf8')
    .digest('hex');
}

function parseUsage(rawLine: string): LocalSkillUsage | null {
  try {
    const value = JSON.parse(rawLine) as Record<string, unknown>;
    if (typeof value.skillName !== 'string' || !value.skillName.trim()
      || typeof value.success !== 'boolean') {
      return null;
    }
    return { skillName: value.skillName.trim(), success: value.success };
  } catch {
    return null;
  }
}

function emptyState(): ReporterState {
  return { schemaVersion: 1, identities: {} };
}

async function readState(filePath: string): Promise<ReporterState> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<ReporterState>;
    if (value.schemaVersion !== 1 || !value.identities || typeof value.identities !== 'object') {
      return emptyState();
    }
    const identities = Object.fromEntries(
      Object.entries(value.identities)
        .filter((entry): entry is [string, string[]] => (
          /^[a-f0-9]{64}$/u.test(entry[0])
          && Array.isArray(entry[1])
        ))
        .slice(-MAX_IDENTITIES)
        .map(([key, ids]) => [
          key,
          ids.filter((id) => /^[a-f0-9]{64}$/u.test(id)).slice(-MAX_EVENT_IDS_PER_IDENTITY),
        ]),
    );
    return { schemaVersion: 1, identities };
  } catch {
    return emptyState();
  }
}

async function writeState(filePath: string, state: ReporterState): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, filePath).catch(async (error: NodeJS.ErrnoException) => {
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error.code ?? '')) throw error;
      await fs.rm(filePath, { force: true });
      await fs.rename(temporaryPath, filePath);
    });
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function installedSkillNames(root: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('market-')) continue;
    const directory = path.join(root, entry.name);
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    try {
      const metadata = JSON.parse(
        await fs.readFile(path.join(directory, '.otto-market.json'), 'utf8'),
      ) as Record<string, unknown>;
      const skillId = typeof metadata.skillId === 'string' ? metadata.skillId.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,120}$/u.test(skillId)) continue;
      names.set(entry.name, skillId);
      names.set(`market-${skillId}`, skillId);
      if (typeof metadata.skillName === 'string' && metadata.skillName.trim()) {
        names.set(metadata.skillName.trim(), skillId);
      }
    } catch {
      // A partial install is ignored until its metadata is complete.
    }
  }
  return names;
}

export class EnterpriseSkillUsageReporter {
  private polling = false;

  constructor(private readonly options: EnterpriseSkillUsageReporterOptions) {}

  async poll(): Promise<number> {
    if (this.polling) return 0;
    const identity = this.options.identity();
    if (!identity?.accountId || !identity.serverUrl) return 0;
    this.polling = true;
    try {
      const installed = await installedSkillNames(this.options.skillsRoot());
      if (installed.size === 0) return 0;
      const raw = await fs.readFile(this.options.usageFile(), 'utf8').catch(() => '');
      if (!raw) return 0;

      const statePath = this.options.stateFile();
      const state = await readState(statePath);
      const key = identityKey(identity);
      const completed = new Set(state.identities[key] ?? []);
      const limit = Math.max(1, this.options.maxEventsPerPoll ?? 50);
      let reported = 0;

      for (const rawLine of raw.split(/\r?\n/u).filter(Boolean).slice(-500)) {
        if (reported >= limit) break;
        const usage = parseUsage(rawLine);
        const skillId = usage ? installed.get(usage.skillName) : undefined;
        if (!usage || !skillId) continue;
        const id = eventId(identity, rawLine);
        if (completed.has(id)) continue;
        try {
          await this.options.report(skillId, usage.success, id);
          completed.add(id);
          reported += 1;
        } catch {
          // Keep failed events pending for the next authenticated online poll.
        }
      }

      if (reported > 0) {
        const nextIdentities = Object.fromEntries(
          Object.entries({ ...state.identities, [key]: [...completed].slice(-MAX_EVENT_IDS_PER_IDENTITY) })
            .slice(-MAX_IDENTITIES),
        );
        await writeState(statePath, { schemaVersion: 1, identities: nextIdentities });
      }
      return reported;
    } finally {
      this.polling = false;
    }
  }
}
