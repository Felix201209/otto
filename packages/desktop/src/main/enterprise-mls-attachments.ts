/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Versioned MLS attachment file encryption. Files are processed one chunk at a
 * time; the per-file DEK and all human-readable metadata are returned only in
 * the manifest that the caller places inside an MLS application payload.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ATTACHMENT_ID = /^mls-attachment-[0-9a-f-]{36}$/;
const MESSAGE_ID = /^mls-message-[0-9a-f-]{36}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONVERSATION_ID = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const MIN_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const AUTH_TAG_BYTES = 16;
const NONCE_PREFIX_BYTES = 8;
const DEK_BYTES = 32;

export interface EnterpriseMlsAttachmentBinding {
  organizationId: string;
  conversationId: string;
  sessionGeneration: number;
  groupId: string;
  epoch: number;
  messageId: string;
}

export interface EnterpriseMlsAttachmentManifest {
  format: 1;
  cipher: 'aes-256-gcm-chunked';
  id: string;
  fileName: string;
  mimeType: string;
  plaintextBytes: number;
  ciphertextBytes: number;
  ciphertextSha256: string;
  chunkBytes: number;
  chunkCount: number;
  dek: string;
  noncePrefix: string;
  binding: EnterpriseMlsAttachmentBinding;
  object: {
    id: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
  };
}

function canonicalBase64(value: string, bytes: number): boolean {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === value;
}

function validGroupId(value: string): boolean {
  if (!value || value.length % 4 !== 0 || value.length > 344) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.length <= 255 && decoded.toString('base64') === value;
}

function validateBinding(
  input: EnterpriseMlsAttachmentBinding,
): EnterpriseMlsAttachmentBinding {
  if (
    !input ||
    !IDENTIFIER.test(input.organizationId) ||
    !CONVERSATION_ID.test(input.conversationId) ||
    !Number.isSafeInteger(input.sessionGeneration) ||
    input.sessionGeneration < 1 ||
    !validGroupId(input.groupId) ||
    !Number.isSafeInteger(input.epoch) ||
    input.epoch < 1 ||
    !MESSAGE_ID.test(input.messageId)
  ) {
    throw new Error('MLS attachment binding is invalid');
  }
  return { ...input };
}

function validateChunkBytes(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_CHUNK_BYTES ||
    value > MAX_CHUNK_BYTES
  ) {
    throw new Error('MLS attachment chunk size is invalid');
  }
  return value;
}

function validateFileMetadata(input: {
  attachmentId: string;
  fileName: string;
  mimeType: string;
}): void {
  if (!ATTACHMENT_ID.test(input.attachmentId)) {
    throw new Error('MLS attachment id is invalid');
  }
  if (
    !input.fileName.trim() ||
    input.fileName.length > 260 ||
    input.fileName.includes('\0') ||
    !input.mimeType.trim() ||
    input.mimeType.length > 255 ||
    !/^[\x20-\x7e]+$/.test(input.mimeType)
  ) {
    throw new Error('MLS attachment file metadata is invalid');
  }
}

function chunkNonce(prefix: Buffer, index: number): Buffer {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffff_ffff) {
    throw new Error('MLS attachment chunk index is invalid');
  }
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  return nonce;
}

function chunkAad(input: {
  manifest: Pick<
    EnterpriseMlsAttachmentManifest,
    | 'format'
    | 'cipher'
    | 'id'
    | 'plaintextBytes'
    | 'chunkBytes'
    | 'chunkCount'
    | 'binding'
  >;
  chunkIndex: number;
  chunkPlaintextBytes: number;
}): Buffer {
  return Buffer.from(
    `otto:mls-attachment:v1\n${JSON.stringify({
      format: input.manifest.format,
      cipher: input.manifest.cipher,
      attachmentId: input.manifest.id,
      binding: input.manifest.binding,
      plaintextBytes: input.manifest.plaintextBytes,
      chunkBytes: input.manifest.chunkBytes,
      chunkCount: input.manifest.chunkCount,
      chunkIndex: input.chunkIndex,
      chunkPlaintextBytes: input.chunkPlaintextBytes,
    })}`,
    'utf8',
  );
}

function expectedChunkPlaintextBytes(
  manifest: Pick<
    EnterpriseMlsAttachmentManifest,
    'plaintextBytes' | 'chunkBytes' | 'chunkCount'
  >,
  index: number,
): number {
  return index === manifest.chunkCount - 1
    ? manifest.plaintextBytes - index * manifest.chunkBytes
    : manifest.chunkBytes;
}

async function readExactly(
  file: fs.promises.FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(
      output,
      offset,
      length - offset,
      position + offset,
    );
    if (result.bytesRead === 0) {
      output.fill(0);
      throw new Error('MLS attachment file ended unexpectedly');
    }
    offset += result.bytesRead;
  }
  return output;
}

async function writeAll(
  file: fs.promises.FileHandle,
  content: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const result = await file.write(content, offset, content.length - offset);
    if (result.bytesWritten === 0) {
      throw new Error('MLS attachment file write made no progress');
    }
    offset += result.bytesWritten;
  }
}

function temporarySibling(target: string): string {
  return `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
}

async function replaceFileAtomic(temporary: string, target: string): Promise<void> {
  await fs.promises.rename(temporary, target);
  try {
    await fs.promises.chmod(target, 0o600);
  } catch {
    // Windows preserves the current-account ACL instead of POSIX modes.
  }
}

export function validateEnterpriseMlsAttachmentManifest(
  value: unknown,
): EnterpriseMlsAttachmentManifest {
  const manifest = value as Partial<EnterpriseMlsAttachmentManifest>;
  const object = manifest?.object as
    | Partial<EnterpriseMlsAttachmentManifest['object']>
    | undefined;
  if (
    manifest?.format !== 1 ||
    manifest.cipher !== 'aes-256-gcm-chunked' ||
    !ATTACHMENT_ID.test(manifest.id ?? '') ||
    typeof manifest.fileName !== 'string' ||
    typeof manifest.mimeType !== 'string' ||
    !Number.isSafeInteger(manifest.plaintextBytes) ||
    (manifest.plaintextBytes ?? -1) < 0 ||
    !Number.isSafeInteger(manifest.ciphertextBytes) ||
    (manifest.ciphertextBytes ?? 0) < 1 ||
    !SHA256.test(manifest.ciphertextSha256 ?? '') ||
    !Number.isSafeInteger(manifest.chunkCount) ||
    (manifest.chunkCount ?? 0) < 1 ||
    (manifest.chunkCount ?? 0) > 0x1_0000_0000 ||
    !canonicalBase64(manifest.dek ?? '', DEK_BYTES) ||
    !canonicalBase64(manifest.noncePrefix ?? '', NONCE_PREFIX_BYTES) ||
    !object ||
    object.id !== manifest.id ||
    object.ciphertextBytes !== manifest.ciphertextBytes ||
    object.ciphertextSha256 !== manifest.ciphertextSha256
  ) {
    throw new Error('MLS attachment manifest is invalid');
  }
  const valid = manifest as EnterpriseMlsAttachmentManifest;
  validateFileMetadata({
    attachmentId: valid.id,
    fileName: valid.fileName,
    mimeType: valid.mimeType,
  });
  const chunkBytes = validateChunkBytes(valid.chunkBytes);
  const expectedChunks = Math.max(
    1,
    Math.ceil(valid.plaintextBytes / chunkBytes),
  );
  const expectedCiphertextBytes =
    valid.plaintextBytes + expectedChunks * AUTH_TAG_BYTES;
  if (
    valid.chunkCount !== expectedChunks ||
    valid.ciphertextBytes !== expectedCiphertextBytes
  ) {
    throw new Error('MLS attachment manifest size is invalid');
  }
  const binding = validateBinding(
    valid.binding,
  );
  return {
    ...valid,
    fileName: valid.fileName.trim(),
    mimeType: valid.mimeType.trim().toLowerCase(),
    binding,
    object: { ...object } as EnterpriseMlsAttachmentManifest['object'],
  };
}

export async function encryptEnterpriseMlsAttachmentFile(input: {
  sourcePath: string;
  ciphertextPath: string;
  attachmentId: string;
  fileName: string;
  mimeType: string;
  binding: EnterpriseMlsAttachmentBinding;
  chunkBytes?: number;
  maxPlaintextBytes?: number;
}): Promise<EnterpriseMlsAttachmentManifest> {
  validateFileMetadata(input);
  const binding = validateBinding(input.binding);
  const chunkBytes = validateChunkBytes(input.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const maxPlaintextBytes = input.maxPlaintextBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 1) {
    throw new Error('MLS attachment maximum size is invalid');
  }
  const sourceMetadata = await fs.promises.lstat(input.sourcePath);
  if (
    sourceMetadata.isSymbolicLink() ||
    !sourceMetadata.isFile() ||
    sourceMetadata.size < 0 ||
    sourceMetadata.size > maxPlaintextBytes
  ) {
    throw new Error('MLS attachment file size is invalid');
  }
  const plaintextBytes = sourceMetadata.size;
  const chunkCount = Math.max(1, Math.ceil(plaintextBytes / chunkBytes));
  if (chunkCount > 0x1_0000_0000) {
    throw new Error('MLS attachment has too many chunks');
  }
  const dek = randomBytes(DEK_BYTES);
  const noncePrefix = randomBytes(NONCE_PREFIX_BYTES);
  const manifestBase = {
    format: 1 as const,
    cipher: 'aes-256-gcm-chunked' as const,
    id: input.attachmentId,
    plaintextBytes,
    chunkBytes,
    chunkCount,
    binding,
  };
  const temporary = temporarySibling(input.ciphertextPath);
  await fs.promises.mkdir(path.dirname(input.ciphertextPath), {
    recursive: true,
    mode: 0o700,
  });
  let source: fs.promises.FileHandle | null = null;
  let target: fs.promises.FileHandle | null = null;
  const digest = createHash('sha256');
  try {
    source = await fs.promises.open(input.sourcePath, 'r');
    target = await fs.promises.open(temporary, 'wx', 0o600);
    for (let index = 0; index < chunkCount; index += 1) {
      const bytes = expectedChunkPlaintextBytes(manifestBase, index);
      const plaintext = await readExactly(
        source,
        bytes,
        index * chunkBytes,
      );
      const nonce = chunkNonce(noncePrefix, index);
      let ciphertext = Buffer.alloc(0);
      let tag = Buffer.alloc(0);
      try {
        const cipher = createCipheriv('aes-256-gcm', dek, nonce);
        cipher.setAAD(
          chunkAad({
            manifest: manifestBase,
            chunkIndex: index,
            chunkPlaintextBytes: bytes,
          }),
        );
        ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        tag = cipher.getAuthTag();
        digest.update(ciphertext).update(tag);
        await writeAll(target, ciphertext);
        await writeAll(target, tag);
      } finally {
        plaintext.fill(0);
        nonce.fill(0);
        ciphertext.fill(0);
        tag.fill(0);
      }
    }
    await target.sync();
    await source.close();
    source = null;
    await target.close();
    target = null;
    const ciphertextSha256 = digest.digest('hex');
    const ciphertextBytes = plaintextBytes + chunkCount * AUTH_TAG_BYTES;
    const manifest: EnterpriseMlsAttachmentManifest = {
      ...manifestBase,
      fileName: input.fileName.trim(),
      mimeType: input.mimeType.trim().toLowerCase(),
      ciphertextBytes,
      ciphertextSha256,
      dek: dek.toString('base64'),
      noncePrefix: noncePrefix.toString('base64'),
      object: {
        id: input.attachmentId,
        ciphertextBytes,
        ciphertextSha256,
      },
    };
    await replaceFileAtomic(temporary, input.ciphertextPath);
    return validateEnterpriseMlsAttachmentManifest(manifest);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await source?.close().catch(() => undefined);
    await target?.close().catch(() => undefined);
    dek.fill(0);
    noncePrefix.fill(0);
  }
}

async function fileSha256(filePath: string, chunkBytes: number): Promise<string> {
  const digest = createHash('sha256');
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const size = (await handle.stat()).size;
    for (let position = 0; position < size; position += chunkBytes) {
      const content = await readExactly(
        handle,
        Math.min(chunkBytes, size - position),
        position,
      );
      try {
        digest.update(content);
      } finally {
        content.fill(0);
      }
    }
    return digest.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function decryptEnterpriseMlsAttachmentFile(input: {
  ciphertextPath: string;
  outputPath: string;
  manifest: EnterpriseMlsAttachmentManifest;
  expectedBinding: EnterpriseMlsAttachmentBinding;
}): Promise<void> {
  const manifest = validateEnterpriseMlsAttachmentManifest(input.manifest);
  const expectedBinding = validateBinding(input.expectedBinding);
  if (JSON.stringify(manifest.binding) !== JSON.stringify(expectedBinding)) {
    throw new Error('MLS attachment binding does not match the active session');
  }
  const metadata = await fs.promises.lstat(input.ciphertextPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size !== manifest.ciphertextBytes
  ) {
    throw new Error('MLS attachment ciphertext size mismatch');
  }
  if (
    (await fileSha256(input.ciphertextPath, manifest.chunkBytes)) !==
    manifest.ciphertextSha256
  ) {
    throw new Error('MLS attachment ciphertext checksum mismatch');
  }
  const dek = Buffer.from(manifest.dek, 'base64');
  const noncePrefix = Buffer.from(manifest.noncePrefix, 'base64');
  const temporary = temporarySibling(input.outputPath);
  await fs.promises.mkdir(path.dirname(input.outputPath), {
    recursive: true,
    mode: 0o700,
  });
  let source: fs.promises.FileHandle | null = null;
  let target: fs.promises.FileHandle | null = null;
  try {
    source = await fs.promises.open(input.ciphertextPath, 'r');
    target = await fs.promises.open(temporary, 'wx', 0o600);
    let position = 0;
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      const plaintextBytes = expectedChunkPlaintextBytes(manifest, index);
      const ciphertext = await readExactly(source, plaintextBytes, position);
      const tag = await readExactly(
        source,
        AUTH_TAG_BYTES,
        position + plaintextBytes,
      );
      position += plaintextBytes + AUTH_TAG_BYTES;
      const nonce = chunkNonce(noncePrefix, index);
      let plaintext = Buffer.alloc(0);
      try {
        const decipher = createDecipheriv('aes-256-gcm', dek, nonce);
        decipher.setAAD(
          chunkAad({
            manifest,
            chunkIndex: index,
            chunkPlaintextBytes: plaintextBytes,
          }),
        );
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        await writeAll(target, plaintext);
      } finally {
        ciphertext.fill(0);
        tag.fill(0);
        nonce.fill(0);
        plaintext.fill(0);
      }
    }
    await target.sync();
    await source.close();
    source = null;
    await target.close();
    target = null;
    await replaceFileAtomic(temporary, input.outputPath);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await source?.close().catch(() => undefined);
    await target?.close().catch(() => undefined);
    dek.fill(0);
    noncePrefix.fill(0);
  }
}
