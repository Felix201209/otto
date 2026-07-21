/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 更新下载层（src/main/update-download.ts）单测——安全审查修复的针对性覆盖：
 *   H1  重定向后的最终 URL 不在 GitHub 白名单 → 拒绝写盘；
 *   M1  写盘超过体积硬上限 → 中止 + 删 .part + 结构化报错（含公式单测）；
 *   以及既有防线的集成路径：sha256 不符删 .part、取消映射 cancelled。
 *
 * fetch 经 FetchLike 注入 mock（不发真网络请求）；文件落在系统临时目录。
 * 放在 renderer 目录的原因同 update-core.test.ts（vitest include 与
 * tsconfig.main rootDir 的双重限制）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  downloadToFile,
  maxAllowedBytes,
  type DownloadJob,
  type DownloadResponseLike,
  type FetchLike,
} from '../main/update-download.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'otto-dl-test-'));
});

afterEach(async () => {
  await fs.promises.rm(dir, { recursive: true, force: true });
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha256Of = (s: string): string =>
  crypto.createHash('sha256').update(s).digest('hex');

/** 构造最小 fetch 响应：chunks 按序吐出后关流。 */
function mkResponse(
  over: Partial<DownloadResponseLike> = {},
  chunks: Uint8Array[] = [enc('installer bytes')],
): DownloadResponseLike {
  const body = new NodeReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  }) as unknown as DownloadResponseLike['body'];
  return {
    ok: true,
    status: 200,
    url: '',
    headers: { get: () => null },
    body,
    ...over,
  };
}

function mkJob(over: Partial<DownloadJob> = {}): DownloadJob {
  return {
    url: 'https://github.com/Felix201209/otto-releases/releases/download/v1.4.1/Otto.dmg',
    expectedSha256: sha256Of('installer bytes'),
    expectedSize: 15, // 'installer bytes'.length
    partPath: path.join(dir, 'Otto.dmg.part'),
    finalPath: path.join(dir, 'Otto.dmg'),
    signal: new AbortController().signal,
    onProgress: () => undefined,
    throttleMs: 0, // 测试不节流，每 chunk 一帧
    ...over,
  };
}

describe('downloadToFile：正常链路', () => {
  it('下载 → sha256 校验通过 → .part 改名落位 finalPath，进度收到最终帧', async () => {
    const frames: Array<[number, number]> = [];
    const job = mkJob({
      fetchImpl: (async () =>
        // 最终 URL 在白名单内（objects.githubusercontent.com 为真实资产域）。
        mkResponse({ url: 'https://objects.githubusercontent.com/real-asset' })) as FetchLike,
      onProgress: (t, total) => frames.push([t, total]),
    });
    const outcome = await downloadToFile(job);
    expect(outcome).toEqual({ ok: true, filePath: job.finalPath });
    expect(fs.readFileSync(job.finalPath, 'utf-8')).toBe('installer bytes');
    expect(fs.existsSync(job.partPath)).toBe(false);
    // 收尾必推一帧 100%（transferred == total == 15）。
    expect(frames[frames.length - 1]).toEqual([15, 15]);
  });

  it('显式配置的 HTTPS 镜像可在同源内完成下载', async () => {
    const job = mkJob({
      url: 'https://updates.example.com/releases/Otto.exe',
      allowedAssetOrigins: ['https://updates.example.com'],
      fetchImpl: (async () =>
        mkResponse({ url: 'https://updates.example.com/assets/Otto.exe' })) as FetchLike,
    });
    const outcome = await downloadToFile(job);
    expect(outcome).toEqual({ ok: true, filePath: job.finalPath });
    expect(fs.readFileSync(job.finalPath, 'utf-8')).toBe('installer bytes');
  });
});

describe('downloadToFile：H1 重定向逃逸白名单', () => {
  it('最终 URL（res.url）在白名单之外 → 拒绝，一个字节都不写盘', async () => {
    const job = mkJob({
      fetchImpl: (async () =>
        mkResponse({ url: 'https://evil.example.com/Otto.dmg' })) as FetchLike,
    });
    const outcome = await downloadToFile(job);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('重定向');
    expect(outcome.error).toContain('拒绝写盘');
    // 拒绝发生在 createWriteStream 之前：.part 与 final 都不存在。
    expect(fs.existsSync(job.partPath)).toBe(false);
    expect(fs.existsSync(job.finalPath)).toBe(false);
  });

  it('res.url 为空（mock/非标准实现）→ 回退请求 URL 判定，白名单内照常下载', async () => {
    const job = mkJob({ fetchImpl: (async () => mkResponse()) as FetchLike });
    const outcome = await downloadToFile(job);
    expect(outcome.ok).toBe(true);
  });
});

describe('downloadToFile：M1 体积硬上限', () => {
  it('maxAllowedBytes 公式：max(标称 + 10MiB, 标称 × 1.05)', () => {
    const MIB = 1024 * 1024;
    // 100MiB 小包：+10MiB（=110MiB）比 1.05x（=105MiB）大 → 取绝对余量。
    expect(maxAllowedBytes(100 * MIB)).toBe(110 * MIB);
    // 1GB 大包：1.05x（=1_050_000_000）比 +10MiB（≈1_010_485_760）大 → 取比例余量。
    expect(maxAllowedBytes(1_000_000_000)).toBe(1_050_000_000);
  });

  it('写盘累计超过上限 → 中止 + 删 .part + 结构化报错（防无界写盘）', async () => {
    const job = mkJob({
      // 三个 5 字节 chunk 共 15 字节，上限压到 4 → 第一个 chunk 即超限。
      fetchImpl: (async () =>
        mkResponse({}, [enc('aaaaa'), enc('bbbbb'), enc('ccccc')])) as FetchLike,
      maxBytes: 4,
    });
    const outcome = await downloadToFile(job);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('安全上限');
    expect(outcome.error).toContain('已中止并删除临时文件');
    expect(fs.existsSync(job.partPath)).toBe(false);
    expect(fs.existsSync(job.finalPath)).toBe(false);
  });
});

describe('downloadToFile：既有防线的集成路径', () => {
  it('sha256 不符 → 报错且 .part 被删、final 不落位', async () => {
    const job = mkJob({
      fetchImpl: (async () => mkResponse()) as FetchLike,
      expectedSha256: sha256Of('something else'),
    });
    const outcome = await downloadToFile(job);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('sha256 校验不通过');
    expect(fs.existsSync(job.partPath)).toBe(false);
    expect(fs.existsSync(job.finalPath)).toBe(false);
  });

  it('AbortError → cancelled:true（取消不算失败）', async () => {
    const job = mkJob({
      fetchImpl: (async () => {
        const e = new Error('This operation was aborted');
        e.name = 'AbortError';
        throw e;
      }) as FetchLike,
    });
    const outcome = await downloadToFile(job);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.cancelled).toBe(true);
  });
});
