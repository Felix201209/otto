/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * sha256 校验（src/main/update-verify.ts）单测——重点是失败路径：
 * 校验不匹配必须**删除文件**并返回结构化错误（无签名时唯一完整性防线，
 * 绝不许把可疑文件留给用户双击）。
 *
 * 放在 renderer 目录的原因同 update-core.test.ts（vitest include 与
 * tsconfig.main rootDir 的双重限制）；被测模块只依赖 node:crypto/node:fs，
 * vitest 跑在 Node 上可直接执行。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeFileSha256, verifyOrDeleteFile } from '../main/update-verify.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-update-test-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

async function writeSample(name: string, content: string): Promise<string> {
  const p = path.join(dir, name);
  await fs.promises.writeFile(p, content, 'utf-8');
  return p;
}

function sha256Of(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('computeFileSha256', () => {
  it('流式哈希与 node:crypto 直接哈希一致（十六进制小写）', async () => {
    const p = await writeSample('a.bin', 'hello otto');
    await expect(computeFileSha256(p)).resolves.toBe(sha256Of('hello otto'));
  });

  it('文件不存在 → reject（不吞错）', async () => {
    await expect(computeFileSha256(path.join(dir, 'missing'))).rejects.toThrow();
  });
});

describe('verifyOrDeleteFile：校验失败必须删文件', () => {
  it('匹配（大小写不敏感）→ ok，文件保留', async () => {
    const p = await writeSample('ok.bin', 'installer bytes');
    const expected = sha256Of('installer bytes').toUpperCase();
    const r = await verifyOrDeleteFile(p, expected);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('不匹配 → 结构化错误 + 文件已被删除（完整性防线不可绕过）', async () => {
    const p = await writeSample('bad.bin', 'tampered bytes');
    const r = await verifyOrDeleteFile(p, 'f'.repeat(64));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('sha256 校验不通过');
    expect(r.error).toContain('已删除');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('文件不可读 → 结构化错误（不抛裸异常）', async () => {
    const r = await verifyOrDeleteFile(path.join(dir, 'missing.bin'), 'a'.repeat(64));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('读取下载文件失败');
  });
});
