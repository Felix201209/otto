/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDataPlatformComposition } from './dataPlatformComposition.js';

const temporaryDirectories: string[] = [];
const closeCallbacks: Array<() => void> = [];

afterEach(() => {
  for (const close of closeCallbacks.splice(0)) close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('data platform composition', () => {
  it('coordinates database, key lifetime and deferred tenant backups', () => {
    const dataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-data-platform-'),
    );
    temporaryDirectories.push(dataDirectory);
    const databasePath = path.join(dataDirectory, 'data.db');
    const keyPath = path.join(dataDirectory, 'account-sync.key');
    const platform = createDataPlatformComposition({
      encryptionKey: {
        keyPath,
        keyBytes: 32,
        invalidKeyMessage: 'invalid test key',
      },
      database: {
        dataDirectory,
        databasePath,
        schemaVersion: 3,
        initializeSchema(database) {
          database.exec('CREATE TABLE samples (value TEXT);');
        },
      },
    });
    closeCallbacks.push(platform.closeDatabase);

    expect(platform.getDatabase()).toBe(platform.getDatabase());
    expect(platform.getReadiness()).toEqual({
      ready: true,
      schemaVersion: 3,
    });
    const firstKey = platform.encryptionKeyProvider.getKey();
    expect(firstKey).toHaveLength(32);

    platform.closeDatabase();
    const replacementKey = Buffer.alloc(32, 7);
    fs.writeFileSync(keyPath, replacementKey);
    expect(platform.encryptionKeyProvider.getKey()).toEqual(replacementKey);

    const organizationIds: string[] = [];
    const collect = (organizationId: string): unknown[] => {
      organizationIds.push(organizationId);
      return [];
    };
    const backup = platform.createBackup({
      defaultOrganizationId: 'org-default',
      listEmployees: collect,
      listTaskLogs: collect,
      listKnowledge: collect,
      listInviteCodes: collect,
      listAuditLogs: collect,
      listAccounts: collect,
      listAccountTags: collect,
      listTickets: collect,
      listTicketDeliveries: collect,
    });

    expect(backup.exportAll('org-selected')).toEqual({
      employees: [],
      taskLogs: [],
      knowledge: [],
      inviteCodes: [],
      auditLogs: [],
      accounts: [],
      accountTags: [],
      tickets: [],
      ticketDeliveries: [],
    });
    expect(organizationIds).toEqual(Array(9).fill('org-selected'));
  });

  it('clears a loaded key even when the database was never opened', () => {
    const dataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'otto-data-platform-key-'),
    );
    temporaryDirectories.push(dataDirectory);
    const keyPath = path.join(dataDirectory, 'account-sync.key');
    const platform = createDataPlatformComposition({
      encryptionKey: {
        keyPath,
        keyBytes: 32,
        invalidKeyMessage: 'invalid test key',
      },
      database: {
        dataDirectory,
        databasePath: path.join(dataDirectory, 'data.db'),
        schemaVersion: 1,
        initializeSchema() {},
      },
    });
    closeCallbacks.push(platform.closeDatabase);

    platform.encryptionKeyProvider.getKey();
    platform.closeDatabase();
    const replacementKey = Buffer.alloc(32, 9);
    fs.writeFileSync(keyPath, replacementKey);

    expect(platform.encryptionKeyProvider.getKey()).toEqual(replacementKey);
    expect(fs.existsSync(path.join(dataDirectory, 'data.db'))).toBe(false);
  });
});
