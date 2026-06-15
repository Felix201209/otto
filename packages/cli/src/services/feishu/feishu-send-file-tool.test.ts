/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SendFeishuFileTool } from './feishu-send-file-tool.js';
import type { FeishuGateway } from './gateway.js';

/**
 * The send_feishu_file tool is the most security-sensitive surface in the
 * Feishu integration: it lets the LLM upload arbitrary local files to a
 * remote chat. Tests verify the sandboxing layer rejects everything
 * outside the contract before any network call happens.
 */

let projectRoot: string;
let outsideRoot: string;
let uploadFileSpy: ReturnType<typeof vi.fn>;
let sendFileSpy: ReturnType<typeof vi.fn>;
let uploadImageSpy: ReturnType<typeof vi.fn>;
let sendImageSpy: ReturnType<typeof vi.fn>;
let mockGateway: FeishuGateway;

function makeTool(opts: {
  activeChatId?: string;
  replyTo?: string;
} = {}): SendFeishuFileTool {
  return new SendFeishuFileTool(
    mockGateway,
    () => opts.activeChatId,
    () => opts.replyTo,
    () => projectRoot,
  );
}

beforeEach(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dvcode-feishu-tool-'));
  outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dvcode-feishu-outside-'));

  uploadFileSpy = vi.fn().mockResolvedValue('file_key_xyz');
  sendFileSpy = vi.fn().mockResolvedValue('msg_123');
  uploadImageSpy = vi.fn().mockResolvedValue('img_key_xyz');
  sendImageSpy = vi.fn().mockResolvedValue('msg_456');

  mockGateway = {
    uploadFile: uploadFileSpy,
    sendFile: sendFileSpy,
    uploadImage: uploadImageSpy,
    sendImage: sendImageSpy,
  } as unknown as FeishuGateway;
});

afterEach(async () => {
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(outsideRoot, { recursive: true, force: true });
});

describe('SendFeishuFileTool — parameter validation', () => {
  it('validateToolParams rejects missing file_path', () => {
    const tool = makeTool();
    expect(tool.validateToolParams({} as never)).toMatch(/file_path/);
  });

  it('validateToolParams rejects non-string file_path', () => {
    const tool = makeTool();
    expect(
      tool.validateToolParams({ file_path: 123 } as unknown as never),
    ).toMatch(/file_path/);
  });

  it('validateToolParams accepts a string file_path', () => {
    const tool = makeTool();
    expect(tool.validateToolParams({ file_path: 'a.txt', user_confirmed: true })).toBeNull();
  });
});

describe('SendFeishuFileTool — execute() error paths', () => {
  it('refuses without an active chat', async () => {
    const tool = makeTool({ activeChatId: undefined });
    const result = await tool.execute(
      { file_path: 'foo.txt', user_confirmed: true },
      new AbortController().signal,
    );
    expect(String(result.llmContent)).toMatch(/No active Feishu chat/);
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });

  it('rejects absolute paths outside the project root (sandbox)', async () => {
    const evil = path.join(outsideRoot, 'evil.txt');
    await fs.writeFile(evil, 'leak me');
    const tool = makeTool({ activeChatId: 'oc_test' });
    const result = await tool.execute(
      { file_path: evil, user_confirmed: true },
      new AbortController().signal,
    );
    expect(String(result.llmContent)).toMatch(/outside the project root/);
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });

  it('rejects path-traversal escapes via ..', async () => {
    // Place a real file outside the project root, then try to reach it
    // from a relative ../ traversal.
    const evilDir = path.dirname(projectRoot);
    const evilName = `evil-${path.basename(outsideRoot)}.txt`;
    const evil = path.join(evilDir, evilName);
    await fs.writeFile(evil, 'leak me');
    try {
      const tool = makeTool({ activeChatId: 'oc_test' });
      const result = await tool.execute(
        { file_path: `../${evilName}`, user_confirmed: true },
        new AbortController().signal,
      );
      expect(String(result.llmContent)).toMatch(/outside the project root/);
      expect(uploadFileSpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(evil, { force: true });
    }
  });

  it('rejects nonexistent files', async () => {
    const tool = makeTool({ activeChatId: 'oc_test' });
    const result = await tool.execute(
      { file_path: 'does-not-exist.txt', user_confirmed: true },
      new AbortController().signal,
    );
    expect(String(result.llmContent)).toMatch(/File not found/);
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });

  it('rejects directories', async () => {
    const dir = path.join(projectRoot, 'subdir');
    await fs.mkdir(dir);
    const tool = makeTool({ activeChatId: 'oc_test' });
    const result = await tool.execute(
      { file_path: 'subdir', user_confirmed: true },
      new AbortController().signal,
    );
    expect(String(result.llmContent)).toMatch(/directory/);
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });

  it.each([
    'malware.exe',
    'lib.dll',
    'run.bat',
    'run.cmd',
    'pwn.ps1',
    'install.msi',
    'tricky.scr',
    'old.com',
    'lib.so',
    'lib.dylib',
    'pwn.sh',
    'evil.bash',
    'evil.zsh',
    'evil.fish',
    'rce.jar',
    'rce.class',
    'tricky.msp',
    'tricky.msc',
  ])('rejects executable extension: %s', async (filename) => {
    const filePath = path.join(projectRoot, filename);
    await fs.writeFile(filePath, 'payload');
    const tool = makeTool({ activeChatId: 'oc_test' });
    const result = await tool.execute(
      { file_path: filename, user_confirmed: true },
      new AbortController().signal,
    );
    expect(String(result.llmContent)).toMatch(/executable\/script extension/);
    expect(uploadFileSpy).not.toHaveBeenCalled();
    expect(uploadImageSpy).not.toHaveBeenCalled();
  });

  it('rejects oversized files (> 50 MiB)', async () => {
    const filePath = path.join(projectRoot, 'huge.bin');
    // Create a 50MiB + 1 byte file using a sparse-allocation trick to keep
    // the test fast and disk-light. Truncate sets size without writing data.
    const fh = fsSync.openSync(filePath, 'w');
    try {
      fsSync.ftruncateSync(fh, 50 * 1024 * 1024 + 1);
    } finally {
      fsSync.closeSync(fh);
    }
    const tool = makeTool({ activeChatId: 'oc_test' });
    const result = await tool.execute(
      { file_path: 'huge.bin', user_confirmed: true },
      new AbortController().signal,
    );
    expect(String(result.llmContent)).toMatch(/too large/i);
    expect(uploadFileSpy).not.toHaveBeenCalled();
  });
});

describe('SendFeishuFileTool — execute() success paths', () => {
  it('uploads and sends a regular file inside the project root', async () => {
    const filePath = path.join(projectRoot, 'report.pdf');
    await fs.writeFile(filePath, 'fake pdf bytes');
    const tool = makeTool({
      activeChatId: 'oc_test',
      replyTo: 'om_origin',
    });
    const result = await tool.execute(
      { file_path: 'report.pdf', user_confirmed: true },
      new AbortController().signal,
    );
    expect(uploadFileSpy).toHaveBeenCalledTimes(1);
    expect(sendFileSpy).toHaveBeenCalledWith(
      'oc_test',
      'file_key_xyz',
      'om_origin',
    );
    expect(uploadImageSpy).not.toHaveBeenCalled();
    expect(String(result.llmContent)).toMatch(/Successfully sent file/);
  });

  it('uses the image upload path for image extensions', async () => {
    const filePath = path.join(projectRoot, 'pic.png');
    // Tiny non-empty buffer is fine — gateway is mocked and won't actually
    // decode the bytes.
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const tool = makeTool({
      activeChatId: 'oc_test',
      replyTo: 'om_origin',
    });
    const result = await tool.execute(
      { file_path: 'pic.png', user_confirmed: true },
      new AbortController().signal,
    );
    expect(uploadImageSpy).toHaveBeenCalledTimes(1);
    expect(sendImageSpy).toHaveBeenCalledWith(
      'oc_test',
      'img_key_xyz',
      'om_origin',
    );
    expect(uploadFileSpy).not.toHaveBeenCalled();
    expect(String(result.llmContent)).toMatch(/Successfully sent image/);
  });

  it('honors explicit chat_id parameter over active chat fallback', async () => {
    const filePath = path.join(projectRoot, 'a.txt');
    await fs.writeFile(filePath, 'hi');
    const tool = makeTool({ activeChatId: 'oc_default' });
    await tool.execute(
      { file_path: 'a.txt', chat_id: 'oc_explicit', user_confirmed: true },
      new AbortController().signal,
    );
    expect(sendFileSpy).toHaveBeenCalledWith(
      'oc_explicit',
      'file_key_xyz',
      undefined,
    );
  });

  it('surfaces gateway upload errors as tool errors (does not throw)', async () => {
    const filePath = path.join(projectRoot, 'a.txt');
    await fs.writeFile(filePath, 'hi');
    uploadFileSpy.mockRejectedValueOnce(new Error('network down'));
    const tool = makeTool({ activeChatId: 'oc_test' });
    const result = await tool.execute(
      { file_path: 'a.txt', user_confirmed: true },
      new AbortController().signal,
    );
    expect(String(result.llmContent)).toMatch(/network down/);
  });

});

describe('SendFeishuFileTool — confirmation gate (enforced in execute)', () => {
  it('refuses to send when user_confirmed is not set, on every call path', async () => {
    const filePath = path.join(projectRoot, 'a.txt');
    await fs.writeFile(filePath, 'hi');
    const tool = makeTool({ activeChatId: 'oc_test' });
    const result = await tool.execute(
      { file_path: 'a.txt' },
      new AbortController().signal,
    );
    expect(String(result.llmContent)).toMatch(/user_confirmed/);
    expect(uploadFileSpy).not.toHaveBeenCalled();
    expect(sendFileSpy).not.toHaveBeenCalled();
  });
});

describe('SendFeishuFileTool — descriptive helpers', () => {
  it('exports a tool name constant', () => {
    expect(SendFeishuFileTool.Name).toBe('send_feishu_file');
  });

  it('getDescription includes the requested path', () => {
    const tool = makeTool();
    expect(tool.getDescription({ file_path: 'docs/x.pdf' })).toContain(
      'docs/x.pdf',
    );
  });
});
