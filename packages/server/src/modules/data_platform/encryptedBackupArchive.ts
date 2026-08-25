/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import fs from 'node:fs';
import { Writable } from 'node:stream';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const OUTER_MAGIC = Buffer.from('OTTOBAK1');
const INNER_MAGIC = Buffer.from('OTTOFILES1');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const RECORD_HEADER_BYTES = 12;

export interface BackupArchiveSourceFile {
  sourcePath: string;
  archivePath: string;
}

function safeArchivePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('backup archive path is invalid');
  }
  return normalized;
}

function recordHeader(pathBytes: number, contentBytes: number): Buffer {
  const header = Buffer.alloc(RECORD_HEADER_BYTES);
  header.writeUInt32BE(pathBytes, 0);
  header.writeBigUInt64BE(BigInt(contentBytes), 4);
  return header;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function createEncryptedBackupArchive(input: {
  files: readonly BackupArchiveSourceFile[];
  targetPath: string;
  key: Buffer;
}): Promise<{ bytes: number; sha256: string; fileCount: number }> {
  if (input.key.length !== 32)
    throw new Error('backup encryption key is invalid');
  if (input.files.length === 0) throw new Error('backup archive has no files');
  const seen = new Set<string>();
  const files = input.files.map((item) => {
    const archivePath = safeArchivePath(item.archivePath);
    if (seen.has(archivePath))
      throw new Error('backup archive path is duplicated');
    seen.add(archivePath);
    const metadata = fs.lstatSync(item.sourcePath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('backup source must be a regular file');
    }
    return { ...item, archivePath, size: metadata.size };
  });
  const targetPath = path.resolve(input.targetPath);
  if (fs.existsSync(targetPath)) {
    throw new Error('backup archive target already exists');
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', input.key, nonce);
  cipher.setAAD(OUTER_MAGIC);
  const handle = await open(temporaryPath, 'wx', 0o600);
  let position = 0;
  const writeRaw = async (chunk: Buffer) => {
    if (chunk.length === 0) return;
    await handle.write(chunk, 0, chunk.length, position);
    position += chunk.length;
  };
  const writePlain = async (chunk: Buffer) => writeRaw(cipher.update(chunk));
  try {
    await writeRaw(Buffer.concat([OUTER_MAGIC, nonce]));
    await writePlain(INNER_MAGIC);
    for (const file of files) {
      const archivePath = Buffer.from(file.archivePath, 'utf8');
      await writePlain(recordHeader(archivePath.length, file.size));
      await writePlain(archivePath);
      for await (const chunk of fs.createReadStream(file.sourcePath)) {
        await writePlain(Buffer.from(chunk));
      }
    }
    await writePlain(recordHeader(0, 0));
    await writeRaw(cipher.final());
    await writeRaw(cipher.getAuthTag());
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temporaryPath, targetPath);
  const metadata = fs.statSync(targetPath);
  return {
    bytes: metadata.size,
    sha256: await sha256File(targetPath),
    fileCount: files.length,
  };
}

async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (result.bytesRead === 0) throw new Error('backup archive is truncated');
    offset += result.bytesRead;
  }
  return buffer;
}

/** Verifies the AES-GCM key without writing decrypted backup content to disk. */
export async function verifyEncryptedBackupArchiveKey(input: {
  archivePath: string;
  key: Buffer;
}): Promise<void> {
  if (input.key.length !== 32)
    throw new Error('backup encryption key is invalid');
  const archivePath = path.resolve(input.archivePath);
  const metadata = fs.lstatSync(archivePath);
  const prefixBytes = OUTER_MAGIC.length + NONCE_BYTES;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= prefixBytes + TAG_BYTES
  ) {
    throw new Error('backup archive is invalid');
  }
  const sourceHandle = await open(archivePath, 'r');
  let prefix: Buffer;
  let tag: Buffer;
  try {
    prefix = await readExact(sourceHandle, prefixBytes, 0);
    tag = await readExact(sourceHandle, TAG_BYTES, metadata.size - TAG_BYTES);
  } finally {
    await sourceHandle.close();
  }
  if (!prefix.subarray(0, OUTER_MAGIC.length).equals(OUTER_MAGIC)) {
    throw new Error('backup archive format is invalid');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    input.key,
    prefix.subarray(OUTER_MAGIC.length),
  );
  decipher.setAAD(OUTER_MAGIC);
  decipher.setAuthTag(tag);
  const discard = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  await pipeline(
    fs.createReadStream(archivePath, {
      start: prefixBytes,
      end: metadata.size - TAG_BYTES - 1,
    }),
    decipher,
    discard,
  );
}

export async function extractEncryptedBackupArchive(input: {
  archivePath: string;
  targetDirectory: string;
  key: Buffer;
}): Promise<{ files: string[] }> {
  if (input.key.length !== 32)
    throw new Error('backup encryption key is invalid');
  const archivePath = path.resolve(input.archivePath);
  const metadata = fs.lstatSync(archivePath);
  const prefixBytes = OUTER_MAGIC.length + NONCE_BYTES;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size <= prefixBytes + TAG_BYTES
  ) {
    throw new Error('backup archive is invalid');
  }
  const prefix = Buffer.alloc(prefixBytes);
  const tag = Buffer.alloc(TAG_BYTES);
  const sourceHandle = await open(archivePath, 'r');
  try {
    await sourceHandle.read(prefix, 0, prefix.length, 0);
    await sourceHandle.read(tag, 0, tag.length, metadata.size - TAG_BYTES);
  } finally {
    await sourceHandle.close();
  }
  if (!prefix.subarray(0, OUTER_MAGIC.length).equals(OUTER_MAGIC)) {
    throw new Error('backup archive format is invalid');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    input.key,
    prefix.subarray(OUTER_MAGIC.length),
  );
  decipher.setAAD(OUTER_MAGIC);
  decipher.setAuthTag(tag);
  const targetDirectory = path.resolve(input.targetDirectory);
  fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(targetDirectory).length > 0) {
    throw new Error('backup extraction target must be empty');
  }
  const plaintextPath = path.join(
    targetDirectory,
    `.decrypting-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  try {
    await pipeline(
      fs.createReadStream(archivePath, {
        start: prefixBytes,
        end: metadata.size - TAG_BYTES - 1,
      }),
      decipher,
      fs.createWriteStream(plaintextPath, { flags: 'wx', mode: 0o600 }),
    );
    const plaintext = await open(plaintextPath, 'r');
    const extracted: string[] = [];
    try {
      let position = 0;
      const innerMagic = await readExact(
        plaintext,
        INNER_MAGIC.length,
        position,
      );
      position += INNER_MAGIC.length;
      if (!innerMagic.equals(INNER_MAGIC)) {
        throw new Error('backup archive inner format is invalid');
      }
      while (true) {
        const header = await readExact(
          plaintext,
          RECORD_HEADER_BYTES,
          position,
        );
        position += RECORD_HEADER_BYTES;
        const pathBytes = header.readUInt32BE(0);
        const contentBytesBig = header.readBigUInt64BE(4);
        if (pathBytes === 0 && contentBytesBig === 0n) break;
        if (
          pathBytes === 0 ||
          pathBytes > 4096 ||
          contentBytesBig > BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          throw new Error('backup archive record is invalid');
        }
        const archiveEntry = safeArchivePath(
          (await readExact(plaintext, pathBytes, position)).toString('utf8'),
        );
        position += pathBytes;
        const contentBytes = Number(contentBytesBig);
        const destination = path.resolve(
          targetDirectory,
          ...archiveEntry.split('/'),
        );
        if (!destination.startsWith(`${targetDirectory}${path.sep}`)) {
          throw new Error('backup archive entry escapes its target');
        }
        fs.mkdirSync(path.dirname(destination), {
          recursive: true,
          mode: 0o700,
        });
        const destinationHandle = await open(destination, 'wx', 0o600);
        try {
          let remaining = contentBytes;
          let destinationPosition = 0;
          while (remaining > 0) {
            const chunkSize = Math.min(1024 * 1024, remaining);
            const chunk = await readExact(plaintext, chunkSize, position);
            await destinationHandle.write(
              chunk,
              0,
              chunk.length,
              destinationPosition,
            );
            position += chunk.length;
            destinationPosition += chunk.length;
            remaining -= chunk.length;
          }
          await destinationHandle.sync();
        } finally {
          await destinationHandle.close();
        }
        extracted.push(archiveEntry);
      }
    } finally {
      await plaintext.close();
    }
    return { files: extracted };
  } catch (error) {
    for (const entry of fs.readdirSync(targetDirectory)) {
      fs.rmSync(path.join(targetDirectory, entry), {
        recursive: true,
        force: true,
      });
    }
    throw error;
  } finally {
    await rm(plaintextPath, { force: true }).catch(() => undefined);
  }
}
