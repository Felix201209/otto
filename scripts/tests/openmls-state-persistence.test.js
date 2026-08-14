import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileMlsStatePersistence } from '../../otto-native/src/index.ts';

const temporaryDirectories = [];

async function temporaryStateFile() {
  const directory = await mkdtemp(path.join(tmpdir(), 'otto-mls-state-'));
  temporaryDirectories.push(directory);
  const nestedDirectory = path.join(directory, 'nested');
  await mkdir(nestedDirectory);
  return path.join(nestedDirectory, 'mls-state.json');
}

function protectStateKey(encoded) {
  return `test-secure-storage:${Buffer.from(encoded, 'utf8').toString('hex')}`;
}

function unprotectStateKey(protectedKey) {
  const prefix = 'test-secure-storage:';
  if (!protectedKey.startsWith(prefix)) {
    throw new Error('secure storage rejected the protected key');
  }
  return Buffer.from(protectedKey.slice(prefix.length), 'hex').toString('utf8');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('FileMlsStatePersistence', () => {
  it('atomically stores only a protected key and encrypted native state', async () => {
    const filePath = await temporaryStateFile();
    const persistence = new FileMlsStatePersistence({
      filePath,
      protectStateKey,
      unprotectStateKey,
    });
    const stateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const stateKeyBase64 = Buffer.from(stateKey).toString('base64');

    await expect(persistence.load()).resolves.toBeNull();
    await persistence.create(stateKey, '{"ciphertext":"first"}');

    const serialized = await readFile(filePath, 'utf8');
    expect(serialized).not.toContain(stateKeyBase64);
    expect(serialized).not.toContain('device_scope');
    expect(JSON.parse(serialized)).toMatchObject({
      format: 1,
      keyProtection: 'os-secure-storage',
      encryptedState: '{"ciphertext":"first"}',
    });
    if (process.platform !== 'win32') {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }

    const loaded = await persistence.load();
    expect(loaded?.stateKey).toEqual(stateKey);
    expect(loaded?.encryptedState).toBe('{"ciphertext":"first"}');

    const protectedStateKey = JSON.parse(serialized).protectedStateKey;
    await persistence.save('{"ciphertext":"second"}');
    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    expect(saved.protectedStateKey).toBe(protectedStateKey);
    expect(saved.encryptedState).toBe('{"ciphertext":"second"}');
    await expect(persistence.create(stateKey, 'duplicate')).rejects.toThrow(
      'already exists',
    );
  });

  it('fails closed when secure storage returns an invalid state key', async () => {
    const filePath = await temporaryStateFile();
    const persistence = new FileMlsStatePersistence({
      filePath,
      protectStateKey,
      unprotectStateKey: () => Buffer.alloc(31, 7).toString('base64'),
    });
    await writeFile(
      filePath,
      JSON.stringify({
        format: 1,
        keyProtection: 'os-secure-storage',
        protectedStateKey: 'untrusted',
        encryptedState: '{"ciphertext":"opaque"}',
      }),
      { encoding: 'utf8' },
    );

    await expect(persistence.load()).rejects.toThrow('invalid size');
  });

  it('fails closed on a malformed state manifest', async () => {
    const filePath = await temporaryStateFile();
    const persistence = new FileMlsStatePersistence({
      filePath,
      protectStateKey,
      unprotectStateKey,
    });
    await writeFile(filePath, '{"format":1,"encryptedState":"opaque"}', {
      encoding: 'utf8',
    });

    await expect(persistence.load()).rejects.toThrow('manifest is invalid');
  });
});
