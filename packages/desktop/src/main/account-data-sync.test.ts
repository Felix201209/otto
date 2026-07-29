/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  EnterpriseAccountSyncPayload,
  EnterpriseAccountSyncScope,
  EnterpriseAccountSyncSnapshot,
} from './enterprise-client.js';
import {
  AccountDataSyncService,
  accountDataSyncIdentityKey,
  type AccountDataSyncIdentity,
  type AccountDataSyncRemote,
} from './account-data-sync.js';

const temporaryRoots: string[] = [];

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function payload(
  filePath: string,
  content: string,
  modifiedAtMs = Date.parse('2026-07-26T08:00:00.000Z'),
): EnterpriseAccountSyncPayload {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-26T08:00:00.000Z',
    files: [{
      path: filePath,
      content,
      modifiedAtMs,
      sha256: digest(content),
    }],
  };
}

class MemoryAccountSyncRemote implements AccountDataSyncRemote {
  readonly snapshots = new Map<EnterpriseAccountSyncScope, EnterpriseAccountSyncSnapshot>();
  private conflict: {
    scope: EnterpriseAccountSyncScope;
    payload: EnterpriseAccountSyncPayload;
  } | null = null;

  injectConflict(
    scope: EnterpriseAccountSyncScope,
    nextPayload: EnterpriseAccountSyncPayload,
  ): void {
    this.conflict = { scope, payload: nextPayload };
  }

  async listAccountSyncSnapshots(): Promise<EnterpriseAccountSyncSnapshot[]> {
    return [...this.snapshots.values()].map((snapshot) => structuredClone(snapshot));
  }

  async putAccountSyncSnapshot(input: {
    scope: EnterpriseAccountSyncScope;
    expectedVersion: number;
    payload: EnterpriseAccountSyncPayload;
    deviceId?: string | null;
  }): Promise<EnterpriseAccountSyncSnapshot> {
    const current = this.snapshots.get(input.scope);
    const currentVersion = current?.version ?? 0;
    if (input.expectedVersion !== currentVersion) {
      throw new Error('account sync version conflict');
    }
    if (this.conflict?.scope === input.scope) {
      const injected = this.conflict;
      this.conflict = null;
      this.snapshots.set(input.scope, {
        scope: input.scope,
        version: currentVersion + 1,
        payload: structuredClone(injected.payload),
        payloadHash: digest(JSON.stringify(injected.payload)),
        deviceId: 'other-device',
        updatedAtMs: Date.parse('2026-07-26T08:01:00.000Z'),
      });
      throw new Error('account sync version conflict');
    }
    const snapshot: EnterpriseAccountSyncSnapshot = {
      scope: input.scope,
      version: currentVersion + 1,
      payload: structuredClone(input.payload),
      payloadHash: digest(JSON.stringify(input.payload)),
      deviceId: input.deviceId ?? null,
      updatedAtMs: Date.parse('2026-07-26T08:02:00.000Z'),
    };
    this.snapshots.set(input.scope, snapshot);
    return structuredClone(snapshot);
  }
}

async function makeDevice(name: string): Promise<{
  root: string;
  userRoot: string;
  worklogRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-account-sync-' + name + '-'));
  temporaryRoots.push(root);
  return {
    root,
    userRoot: path.join(root, 'otto-user'),
    worklogRoot: path.join(root, 'worklog'),
  };
}

async function writeText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

const IDENTITY: AccountDataSyncIdentity = {
  serverUrl: 'https://enterprise.example.test',
  accountId: 'account-521920',
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fs.rm(root, { recursive: true, force: true })
  )));
});

describe('account data sync', () => {
  it('protects account mirrors and never writes plaintext when protection is unavailable', async () => {
    const device = await makeDevice('protected-mirror');
    const memoryPath = path.join(device.userRoot, 'memory', 'global.md');
    await writeText(memoryPath, '- Sensitive account memory\n');
    const protectMirror = (plaintext: string) => Buffer.from(plaintext, 'utf8').toString('base64');
    const unprotectMirror = (sealed: string) => Buffer.from(sealed, 'base64').toString('utf8');
    const remote = new MemoryAccountSyncRemote();
    const protectedService = new AccountDataSyncService({
      userRoot: device.userRoot,
      worklogRoot: device.worklogRoot,
      deviceId: 'protected-device',
      protectMirror,
      unprotectMirror,
    });

    await protectedService.sync(remote, IDENTITY);
    const mirrorPath = path.join(
      device.userRoot,
      'account-sync',
      'profiles',
      accountDataSyncIdentityKey(IDENTITY),
      'personal_memory.json',
    );
    const storedMirror = await fs.readFile(mirrorPath, 'utf8');
    expect(storedMirror).not.toContain('Sensitive account memory');
    expect(JSON.parse(storedMirror)).toMatchObject({
      schemaVersion: 1,
      protection: 'electron-safe-storage',
    });

    const unavailableDevice = await makeDevice('unavailable-protection');
    await writeText(
      path.join(unavailableDevice.userRoot, 'memory', 'global.md'),
      '- Must not reach a plaintext mirror\n',
    );
    const unavailableService = new AccountDataSyncService({
      userRoot: unavailableDevice.userRoot,
      worklogRoot: unavailableDevice.worklogRoot,
      deviceId: 'unavailable-device',
      protectMirror: () => null,
      unprotectMirror,
    });
    await unavailableService.sync(new MemoryAccountSyncRemote(), IDENTITY);
    await expect(fs.stat(path.join(
      unavailableDevice.userRoot,
      'account-sync',
      'profiles',
      accountDataSyncIdentityKey(IDENTITY),
      'personal_memory.json',
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores personal memory, worklogs and generated skills on a new device', async () => {
    const first = await makeDevice('source');
    await writeText(
      path.join(first.userRoot, 'memory', 'global.md'),
      '# Personal memory\n- Prefers concise project updates\n',
    );
    await writeText(
      path.join(first.userRoot, 'memory', 'sessions', 'project-a.md'),
      '- Project A deploys on Fridays\n',
    );
    await writeText(
      path.join(first.userRoot, 'knowledge', 'entries.jsonl'),
      '{"id":"kb_account_sync","category":"preference","content":"Use account-scoped knowledge","tags":["sync"],"createdAt":"2026-07-26T08:00:00.000Z"}\n',
    );
    await writeText(
      path.join(first.worklogRoot, '2026', '07', '26.jsonl'),
      '{"createdAt":"2026-07-26T08:00:00.000Z","summary":"Completed park statistics"}\n',
    );
    await writeText(
      path.join(first.userRoot, 'skills', 'auto-project-review', 'SKILL.md'),
      '# Project review\nUse the account worklog before drafting a review.\n',
    );
    await writeText(
      path.join(first.userRoot, 'skills', 'auto-project-review', 'profile.json'),
      '{"name":"project-review","source":"learned"}\n',
    );

    const remote = new MemoryAccountSyncRemote();
    const firstService = new AccountDataSyncService({
      userRoot: first.userRoot,
      worklogRoot: first.worklogRoot,
      deviceId: 'source-device',
      now: () => new Date('2026-07-26T08:10:00.000Z'),
    });
    await firstService.sync(remote, IDENTITY);
    expect([...remote.snapshots.keys()].sort()).toEqual([
      'auto_skills',
      'personal_memory',
      'worklog',
    ]);
    expect(
      remote.snapshots.get('personal_memory')?.payload.files.map((file) => file.path),
    ).toEqual([
      'knowledge/entries.jsonl',
      'memory/global.md',
      'memory/sessions/project-a.md',
    ]);

    const second = await makeDevice('restored');
    const secondService = new AccountDataSyncService({
      userRoot: second.userRoot,
      worklogRoot: second.worklogRoot,
      deviceId: 'restored-device',
      now: () => new Date('2026-07-26T08:20:00.000Z'),
    });
    const summary = await secondService.sync(remote, IDENTITY);

    expect(summary.restoredFiles).toBeGreaterThanOrEqual(6);
    expect(await fs.readFile(
      path.join(second.userRoot, 'memory', 'global.md'),
      'utf8',
    )).toContain('Prefers concise project updates');
    expect(await fs.readFile(
      path.join(second.userRoot, 'memory', 'sessions', 'project-a.md'),
      'utf8',
    )).toContain('Project A deploys on Fridays');
    expect(await fs.readFile(
      path.join(second.userRoot, 'knowledge', 'entries.jsonl'),
      'utf8',
    )).toContain('Use account-scoped knowledge');
    expect(await fs.readFile(
      path.join(second.worklogRoot, '2026', '07', '26.jsonl'),
      'utf8',
    )).toContain('Completed park statistics');
    expect(await fs.readFile(
      path.join(second.userRoot, 'skills', 'auto-project-review', 'SKILL.md'),
      'utf8',
    )).toContain('Use the account worklog');
    expect(await fs.readFile(
      path.join(second.userRoot, 'skills', 'auto-project-review', 'profile.json'),
      'utf8',
    )).toContain('"source":"learned"');
  });

  it('keeps managed files isolated while switching accounts on one computer', async () => {
    const device = await makeDevice('switch');
    const service = new AccountDataSyncService({
      userRoot: device.userRoot,
      worklogRoot: device.worklogRoot,
      deviceId: 'switch-device',
      now: () => new Date('2026-07-26T09:00:00.000Z'),
    });
    const identityA = { ...IDENTITY, accountId: 'account-a' };
    const identityB = { ...IDENTITY, accountId: 'account-b' };
    const memoryPath = path.join(device.userRoot, 'memory', 'global.md');

    await writeText(memoryPath, '- Account A private preference\n');
    await service.activate(identityA);
    await service.activate(identityB);
    await expect(fs.readFile(memoryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await writeText(memoryPath, '- Account B private preference\n');
    await service.activate(identityA);
    expect(await fs.readFile(memoryPath, 'utf8')).toContain('Account A private preference');
    expect(await fs.readFile(memoryPath, 'utf8')).not.toContain('Account B private preference');

    await service.activate(identityB);
    expect(await fs.readFile(memoryPath, 'utf8')).toContain('Account B private preference');
    expect(await fs.readFile(memoryPath, 'utf8')).not.toContain('Account A private preference');
  });

  it('erases managed personal data and the account mirror after account deletion', async () => {
    const device = await makeDevice('erase');
    const service = new AccountDataSyncService({
      userRoot: device.userRoot,
      worklogRoot: device.worklogRoot,
      deviceId: 'erase-device',
      now: () => new Date('2026-07-26T09:05:00.000Z'),
    });
    await writeText(
      path.join(device.userRoot, 'memory', 'global.md'),
      '- Private memory to delete\n',
    );
    await writeText(
      path.join(device.worklogRoot, '2026', '07', '26.jsonl'),
      '{"summary":"Private worklog to delete"}\n',
    );
    await writeText(
      path.join(device.userRoot, 'skills', 'auto-private', 'SKILL.md'),
      '# Private generated skill\n',
    );

    const remote = new MemoryAccountSyncRemote();
    await service.sync(remote, IDENTITY);
    const identityKey = accountDataSyncIdentityKey(IDENTITY);
    const mirrorRoot = path.join(
      device.userRoot,
      'account-sync',
      'profiles',
      identityKey,
    );
    expect((await fs.readdir(mirrorRoot)).length).toBeGreaterThan(0);

    await service.erase(IDENTITY);

    await expect(fs.stat(path.join(device.userRoot, 'memory', 'global.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(device.worklogRoot, '2026', '07', '26.jsonl')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(device.userRoot, 'skills', 'auto-private', 'SKILL.md')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(mirrorRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('merges a concurrent remote memory update and retries with the latest version', async () => {
    const device = await makeDevice('conflict');
    const memoryPath = path.join(device.userRoot, 'memory', 'global.md');
    await writeText(memoryPath, '- Local fact from this computer\n');

    const remote = new MemoryAccountSyncRemote();
    remote.injectConflict(
      'personal_memory',
      payload('memory/global.md', '- Remote fact from another computer\n'),
    );
    const service = new AccountDataSyncService({
      userRoot: device.userRoot,
      worklogRoot: device.worklogRoot,
      deviceId: 'conflict-device',
      now: () => new Date('2026-07-26T09:10:00.000Z'),
    });
    const summary = await service.sync(remote, IDENTITY);

    expect(summary.conflictMerges).toBe(1);
    const localMemory = await fs.readFile(memoryPath, 'utf8');
    expect(localMemory).toContain('Local fact from this computer');
    expect(localMemory).toContain('Remote fact from another computer');
    const remoteMemory = remote.snapshots.get('personal_memory')?.payload.files
      .find((file) => file.path === 'memory/global.md')?.content;
    expect(remoteMemory).toContain('Local fact from this computer');
    expect(remoteMemory).toContain('Remote fact from another computer');
  });
});
