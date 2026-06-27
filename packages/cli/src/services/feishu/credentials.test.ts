/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Tests use a per-test isolated fake-home dir inside the OS tmp dir, with
 * os.homedir() mocked to return it, so they never touch the user's real
 * ~/.otto directory. credentials.ts always writes to <home>/.otto/.
 *
 * Note: on Windows, process.env.USERPROFILE is NOT consulted by the native
 * os.homedir() impl, so vi.mock is the only portable interception point.
 */
let fakeHome = '';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: actual,
    homedir: () => fakeHome || actual.homedir(),
  };
});

const {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  isSenderAuthorized,
  CredentialsLoadError,
} = await import('./credentials.js');
type FeishuCredentials = import('./credentials.js').FeishuCredentials;

let credsDir: string;

beforeEach(async () => {
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-feishu-creds-'));
  credsDir = path.join(fakeHome, '.otto-user');
});

afterEach(async () => {
  const toDelete = fakeHome;
  fakeHome = '';
  await fs.rm(toDelete, { recursive: true, force: true });
});

const baseCreds: FeishuCredentials = {
  appId: 'cli_test_app',
  appSecret: 'super-secret-value-do-not-leak',
  domain: 'feishu',
  botName: 'TestBot',
  ownerOpenId: 'ou_owner_123',
  allowlist: ['ou_user_a', 'ou_user_b'],
};

describe('FeishuCredentials — round-trip', () => {
  it('saveCredentials then loadCredentials returns the original object', async () => {
    await saveCredentials(baseCreds);
    const loaded = await loadCredentials();
    expect(loaded).toEqual(baseCreds);
  });

  it('returns null when credentials file does not exist', async () => {
    const loaded = await loadCredentials();
    expect(loaded).toBeNull();
  });

  it('clearCredentials removes the file (subsequent load returns null)', async () => {
    await saveCredentials(baseCreds);
    await clearCredentials();
    const loaded = await loadCredentials();
    expect(loaded).toBeNull();
  });

  it('clearCredentials is idempotent on a missing file', async () => {
    await expect(clearCredentials()).resolves.toBeUndefined();
    await expect(clearCredentials()).resolves.toBeUndefined();
  });
});

describe('FeishuCredentials — encryption format', () => {
  it('persists ciphertext, never the plaintext appSecret', async () => {
    await saveCredentials(baseCreds);
    const filePath = path.join(credsDir, 'feishu-credentials.json');
    const onDisk = await fs.readFile(filePath, 'utf8');
    expect(onDisk).not.toContain(baseCreds.appSecret);
    expect(onDisk).not.toContain(baseCreds.appId);
    // Default format is now AES-256-GCM (prefixed)
    expect(onDisk.startsWith('gcm:')).toBe(true);
  });

  it('writes credentials and key files with mode 0o600 on POSIX', async () => {
    if (process.platform === 'win32') {
      // Windows POSIX permission bits are not meaningful — skip.
      return;
    }
    await saveCredentials(baseCreds);
    const filePath = path.join(credsDir, 'feishu-credentials.json');
    const keyFilePath = path.join(credsDir, 'feishu-key');

    const credStat = await fs.stat(filePath);
    const keyStat = await fs.stat(keyFilePath);
    // Mask off file-type bits and compare the lower 9 permission bits.
    expect(credStat.mode & 0o777).toBe(0o600);
    expect(keyStat.mode & 0o777).toBe(0o600);
  });

  it('throws CredentialsLoadError when ciphertext is corrupted', async () => {
    await saveCredentials(baseCreds);
    const filePath = path.join(credsDir, 'feishu-credentials.json');
    // Flip a hex character inside the ciphertext payload to invalidate the GCM tag.
    const original = await fs.readFile(filePath, 'utf8');
    const corrupted = original.replace(/[0-9a-f]$/i, (last) =>
      last === '0' ? '1' : '0',
    );
    await fs.writeFile(filePath, corrupted);

    await expect(loadCredentials()).rejects.toBeInstanceOf(
      CredentialsLoadError,
    );
  });

  it('throws CredentialsLoadError when key file is replaced (cannot decrypt)', async () => {
    await saveCredentials(baseCreds);
    const keyFilePath = path.join(credsDir, 'feishu-key');
    // Overwrite key with a different random 32-byte key.
    await fs.writeFile(keyFilePath, crypto.randomBytes(32), { mode: 0o600 });
    await expect(loadCredentials()).rejects.toBeInstanceOf(
      CredentialsLoadError,
    );
  });

  it('rejects legacy AES-256-CBC ciphertext (fail-closed, no CBC fallback)', async () => {
    // Synthesise a legacy file: <iv-hex>:<cbc-hex> with no 'gcm:' prefix.
    // After the security fix, CBC blobs must be rejected with CredentialsLoadError
    // because CBC provides no integrity guarantee (tamper / padding-oracle risk).
    await fs.mkdir(credsDir, { recursive: true });
    const key = crypto.randomBytes(32);
    await fs.writeFile(path.join(credsDir, 'feishu-key'), key, { mode: 0o600 });
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const json = JSON.stringify(baseCreds);
    const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
    const legacyPayload = `${iv.toString('hex')}:${enc.toString('hex')}`;
    await fs.writeFile(
      path.join(credsDir, 'feishu-credentials.json'),
      legacyPayload,
      { mode: 0o600 },
    );

    await expect(loadCredentials()).rejects.toBeInstanceOf(CredentialsLoadError);
  });
});

describe('FeishuCredentials — file location resolution', () => {
  it('saves under <home>/.otto (global, not project)', async () => {
    await saveCredentials(baseCreds);
    const filePath = path.join(credsDir, 'feishu-credentials.json');
    expect(fsSync.existsSync(filePath)).toBe(true);
  });
});

describe('isSenderAuthorized', () => {
  it('allows the owner', () => {
    expect(isSenderAuthorized(baseCreds, 'ou_owner_123')).toBe(true);
  });

  it('allows users in allowlist', () => {
    expect(isSenderAuthorized(baseCreds, 'ou_user_a')).toBe(true);
    expect(isSenderAuthorized(baseCreds, 'ou_user_b')).toBe(true);
  });

  it('denies unknown senders', () => {
    expect(isSenderAuthorized(baseCreds, 'ou_unknown')).toBe(false);
  });

  it('denies empty / missing sender id', () => {
    expect(isSenderAuthorized(baseCreds, '')).toBe(false);
  });

  it('denies all when neither owner nor allowlist set (legacy creds)', () => {
    const legacy: FeishuCredentials = {
      appId: 'cli_x',
      appSecret: 'sec_x',
      domain: 'feishu',
    };
    expect(isSenderAuthorized(legacy, 'ou_anyone')).toBe(false);
  });

  it('allows owner even if allowlist undefined', () => {
    const ownerOnly: FeishuCredentials = {
      appId: 'cli_x',
      appSecret: 'sec_x',
      domain: 'feishu',
      ownerOpenId: 'ou_owner',
    };
    expect(isSenderAuthorized(ownerOnly, 'ou_owner')).toBe(true);
    expect(isSenderAuthorized(ownerOnly, 'ou_other')).toBe(false);
  });
});
