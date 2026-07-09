/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 下载文件的 sha256 完整性校验（只依赖 node:crypto / node:fs，不碰 Electron，
 * 因此可被 vitest 直接单测——update-service.ts 里带 Electron 的部分测不了）。
 *
 * 为什么不能省：桌面安装包目前没有代码签名，sha256 是唯一的完整性防线。
 * 校验不通过必须删除下载文件并明确报错，绝不允许把可疑文件留给用户双击。
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/** 流式计算文件 sha256（十六进制小写）。大文件不整读进内存。 */
export function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export type VerifyResult =
  | { ok: true; sha256: string }
  | { ok: false; error: string };

/**
 * 校验文件 sha256；不匹配时**删除该文件**并返回结构化错误。
 * 期望值大小写不敏感（清单可能给大写十六进制）。
 */
export async function verifyOrDeleteFile(
  filePath: string,
  expectedSha256: string,
): Promise<VerifyResult> {
  let actual: string;
  try {
    actual = await computeFileSha256(filePath);
  } catch (e) {
    return {
      ok: false,
      error: `读取下载文件失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (actual === expectedSha256.toLowerCase()) {
    return { ok: true, sha256: actual };
  }
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // 删除失败不掩盖主错误：照样报校验不通过（文件可能已被用户移动）。
  }
  return {
    ok: false,
    error:
      `安装包 sha256 校验不通过（期望 ${expectedSha256.slice(0, 12)}…，` +
      `实际 ${actual.slice(0, 12)}…），已删除下载文件，请重新下载`,
  };
}
