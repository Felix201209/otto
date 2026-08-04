/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  decryptEnterpriseMlsAttachmentFile,
  encryptEnterpriseMlsAttachmentFile,
  validateEnterpriseMlsAttachmentManifest,
  type EnterpriseMlsAttachmentBinding,
} from './enterprise-mls-attachments.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'otto-mls-attachment-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

const binding: EnterpriseMlsAttachmentBinding = {
  organizationId: 'org-a',
  conversationId: 'a'.repeat(64),
  sessionGeneration: 3,
  groupId: Buffer.from('group-a').toString('base64'),
  epoch: 7,
  messageId: 'mls-message-018f0000-0000-7000-8000-000000000001',
};

describe('MLS private-message attachment files', () => {
  it('round-trips a multi-chunk file with a random per-file DEK and bound AAD', async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.bin');
    const ciphertextPath = path.join(directory, 'ciphertext.bin');
    const outputPath = path.join(directory, 'output.bin');
    const plaintext = Buffer.alloc(256 * 1024 + 37);
    for (let index = 0; index < plaintext.length; index += 1) {
      plaintext[index] = index % 251;
    }
    fs.writeFileSync(sourcePath, plaintext);

    const manifest = await encryptEnterpriseMlsAttachmentFile({
      sourcePath,
      ciphertextPath,
      attachmentId: 'mls-attachment-018f0000-0000-7000-8000-000000000001',
      fileName: '设计稿.bin',
      mimeType: 'application/octet-stream',
      binding,
      chunkBytes: 64 * 1024,
      maxPlaintextBytes: 10 * 1024 * 1024,
    });

    expect(manifest).toMatchObject({
      format: 1,
      cipher: 'aes-256-gcm-chunked',
      plaintextBytes: plaintext.length,
      chunkBytes: 64 * 1024,
      chunkCount: 5,
      binding,
      object: {
        id: 'mls-attachment-018f0000-0000-7000-8000-000000000001',
      },
    });
    expect(Buffer.from(manifest.dek, 'base64')).toHaveLength(32);
    expect(Buffer.from(manifest.noncePrefix, 'base64')).toHaveLength(8);
    expect(manifest.ciphertextBytes).toBe(plaintext.length + 5 * 16);
    expect(fs.statSync(ciphertextPath).size).toBe(manifest.ciphertextBytes);
    expect(fs.readFileSync(ciphertextPath)).not.toContain(plaintext.subarray(0, 64));
    expect(validateEnterpriseMlsAttachmentManifest(manifest)).toEqual(manifest);

    await decryptEnterpriseMlsAttachmentFile({
      ciphertextPath,
      outputPath,
      manifest,
      expectedBinding: binding,
    });
    expect(fs.readFileSync(outputPath)).toEqual(plaintext);
  });

  it('fails closed on object tampering or a cross-generation binding', async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.txt');
    const ciphertextPath = path.join(directory, 'ciphertext.bin');
    const outputPath = path.join(directory, 'output.txt');
    fs.writeFileSync(sourcePath, 'highly confidential');
    const manifest = await encryptEnterpriseMlsAttachmentFile({
      sourcePath,
      ciphertextPath,
      attachmentId: 'mls-attachment-018f0000-0000-7000-8000-000000000002',
      fileName: 'secret.txt',
      mimeType: 'text/plain',
      binding,
    });

    await expect(
      decryptEnterpriseMlsAttachmentFile({
        ciphertextPath,
        outputPath,
        manifest,
        expectedBinding: { ...binding, sessionGeneration: 4 },
      }),
    ).rejects.toThrow('binding');
    expect(fs.existsSync(outputPath)).toBe(false);

    const ciphertext = fs.readFileSync(ciphertextPath);
    ciphertext[ciphertext.length - 1] ^= 1;
    fs.writeFileSync(ciphertextPath, ciphertext);
    await expect(
      decryptEnterpriseMlsAttachmentFile({
        ciphertextPath,
        outputPath,
        manifest,
        expectedBinding: binding,
      }),
    ).rejects.toThrow('checksum');
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('represents a zero-byte file as one authenticated empty chunk', async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'empty.txt');
    const ciphertextPath = path.join(directory, 'ciphertext.bin');
    const outputPath = path.join(directory, 'output.txt');
    fs.writeFileSync(sourcePath, Buffer.alloc(0));

    const manifest = await encryptEnterpriseMlsAttachmentFile({
      sourcePath,
      ciphertextPath,
      attachmentId: 'mls-attachment-018f0000-0000-7000-8000-000000000004',
      fileName: 'empty.txt',
      mimeType: 'text/plain',
      binding,
    });

    expect(manifest).toMatchObject({
      plaintextBytes: 0,
      ciphertextBytes: 16,
      chunkCount: 1,
    });
    await decryptEnterpriseMlsAttachmentFile({
      ciphertextPath,
      outputPath,
      manifest,
      expectedBinding: binding,
    });
    expect(fs.statSync(outputPath).size).toBe(0);
  });

  it('rejects oversized files before creating ciphertext', async () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, 'source.bin');
    const ciphertextPath = path.join(directory, 'ciphertext.bin');
    fs.writeFileSync(sourcePath, Buffer.alloc(65));

    await expect(
      encryptEnterpriseMlsAttachmentFile({
        sourcePath,
        ciphertextPath,
        attachmentId:
          'mls-attachment-018f0000-0000-7000-8000-000000000003',
        fileName: 'source.bin',
        mimeType: 'application/octet-stream',
        binding,
        maxPlaintextBytes: 64,
      }),
    ).rejects.toThrow('size');
    expect(fs.existsSync(ciphertextPath)).toBe(false);
  });
});
