/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface PrivacyDeletionTombstone {
  accountId: string;
  organizationId: string;
  requestedAtMs: number;
}

interface EncryptedLedgerLine {
  v: 1;
  iv: string;
  ciphertext: string;
  tag: string;
}

function readOrCreateKey(keyPath: string): Buffer {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, randomBytes(32).toString('base64url'), {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
  }
  const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64url');
  if (key.length !== 32) throw new Error('privacy deletion ledger key is invalid');
  return key;
}

export function createPrivacyDeletionLedger(input: {
  ledgerPath: string;
  keyPath: string;
}) {
  const append = (entry: PrivacyDeletionTombstone): void => {
    const key = readOrCreateKey(input.keyPath);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(entry), 'utf8'), cipher.final(),
    ]);
    const line: EncryptedLedgerLine = {
      v: 1,
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    };
    fs.mkdirSync(path.dirname(input.ledgerPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(input.ledgerPath, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
  };
  const list = (): PrivacyDeletionTombstone[] => {
    if (!fs.existsSync(input.ledgerPath)) return [];
    if (!fs.existsSync(input.keyPath)) {
      throw new Error('privacy deletion ledger key is missing');
    }
    const key = readOrCreateKey(input.keyPath);
    const entries = new Map<string, PrivacyDeletionTombstone>();
    for (const raw of fs.readFileSync(input.ledgerPath, 'utf8').split(/\r?\n/u)) {
      if (!raw.trim()) continue;
      const line = JSON.parse(raw) as EncryptedLedgerLine;
      if (line.v !== 1) throw new Error('privacy deletion ledger version is unsupported');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(line.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(line.tag, 'base64url'));
      const entry = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(line.ciphertext, 'base64url')), decipher.final(),
      ]).toString('utf8')) as PrivacyDeletionTombstone;
      if (!entry.accountId || !entry.organizationId || !Number.isFinite(entry.requestedAtMs)) {
        throw new Error('privacy deletion ledger entry is invalid');
      }
      entries.set(`${entry.organizationId}\0${entry.accountId}`, entry);
    }
    return [...entries.values()];
  };
  return { append, list };
}
