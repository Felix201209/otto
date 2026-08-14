/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createFileSqlCipherKeyProvider } from './fileSqlCipherKeyProvider.js';

const temporaryDirectories: string[] = [];

function createKeyPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-db-keyring-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'database.keyring.json');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('file SQLCipher key provider', () => {
  it('durably stages, commits, and retains the previous key for recovery', () => {
    const keyPath = createKeyPath();
    const provider = createFileSqlCipherKeyProvider({ keyPath });
    const first = provider.getKeyCandidates()[0]!;

    const rotation = provider.beginRotation();
    const stagedCurrentKey = Buffer.from(rotation.current.key);
    const stagedNextKey = Buffer.from(rotation.next.key);
    expect(rotation.current).toEqual(first);
    expect(rotation.next.version).toBe(2);
    expect(rotation.next.key.equals(first.key)).toBe(false);

    provider.clear();
    const afterCrash = createFileSqlCipherKeyProvider({ keyPath });
    expect(
      afterCrash.getKeyCandidates().map((candidate) => candidate.version),
    ).toEqual([1, 2]);

    const resumedRotation = afterCrash.beginRotation();
    afterCrash.commitRotation(resumedRotation);
    afterCrash.clear();
    const committed = createFileSqlCipherKeyProvider({ keyPath });
    expect(
      committed.getKeyCandidates().map((candidate) => candidate.version),
    ).toEqual([2, 1]);
    expect(committed.getKeyCandidates()[0]!.key).toEqual(stagedNextKey);
    expect(committed.getKeyCandidates()[1]!.key).toEqual(stagedCurrentKey);
  });

  it('promotes a recovery key after an interrupted database replacement', () => {
    const keyPath = createKeyPath();
    const provider = createFileSqlCipherKeyProvider({ keyPath });
    const rotation = provider.beginRotation();
    const previousKey = Buffer.from(rotation.current.key);
    provider.commitRotation(rotation);

    provider.recover(rotation.current.version);
    provider.clear();

    const recovered = createFileSqlCipherKeyProvider({ keyPath });
    expect(recovered.getKeyCandidates()[0]!.version).toBe(1);
    expect(recovered.getKeyCandidates()[0]!.key).toEqual(previousKey);
  });

  it('removes a staged key when a rotation is safely aborted', () => {
    const keyPath = createKeyPath();
    const provider = createFileSqlCipherKeyProvider({ keyPath });
    const rotation = provider.beginRotation();

    provider.abortRotation(rotation);
    provider.clear();

    const reopened = createFileSqlCipherKeyProvider({ keyPath });
    expect(
      reopened.getKeyCandidates().map((candidate) => candidate.version),
    ).toEqual([1]);
  });

  it('supports a read-only raw offline key without rewriting it', () => {
    const keyPath = createKeyPath();
    const raw = Buffer.alloc(32, 9);
    fs.writeFileSync(keyPath, raw);
    const provider = createFileSqlCipherKeyProvider({
      keyPath,
      createIfMissing: false,
      writable: false,
      keyId: 'air-gapped-custody-key',
    });

    expect(provider.getKeyCandidates()).toEqual([
      { id: 'air-gapped-custody-key', version: 1, key: raw },
    ]);
    expect(() => provider.beginRotation()).toThrow(/read-only offline key/i);
    expect(fs.readFileSync(keyPath)).toEqual(raw);
  });

  it('does not silently create a replacement for a missing custody key', () => {
    const keyPath = createKeyPath();
    const provider = createFileSqlCipherKeyProvider({
      keyPath,
      createIfMissing: false,
      writable: false,
    });

    expect(() => provider.getKeyCandidates()).toThrow(/does not exist/i);
    expect(fs.existsSync(keyPath)).toBe(false);
  });
});
