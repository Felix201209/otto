/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type VerifiedManifestJson =
  | { ok: true; json: unknown }
  | { ok: false; error: string };

export function parseVerifiedManifestJson(
  text: string,
  expectedSha256?: string,
): VerifiedManifestJson {
  if (expectedSha256 !== undefined) {
    if (!SHA256_PATTERN.test(expectedSha256)) {
      return { ok: false, error: '更新策略中的清单 SHA-256 格式无效' };
    }
    const actual = createHash('sha256').update(text, 'utf8').digest('hex');
    if (actual !== expectedSha256) {
      return { ok: false, error: '更新清单 SHA-256 校验失败，已拒绝使用' };
    }
  }
  try {
    return { ok: true, json: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: '更新清单不是有效的 JSON' };
  }
}
