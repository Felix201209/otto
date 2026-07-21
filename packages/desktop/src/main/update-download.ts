/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 更新安装包的流式下载（从 update-service.ts 抽出的无 Electron 依赖层，
 * fetch 可注入 → 安全关键路径可被 vitest 直接单测）。
 *
 * 安全审查修复点（2026-07-08）：
 *   H1  重定向逃逸：fetch 虽 redirect:'follow'，但响应到手后必须再验**最终 URL**
 *       （res.url）仍在 GitHub 白名单内，否则拒绝写盘——只验第一跳挡不住
 *       「白名单内 302 → 恶意域」。
 *   M1  体积硬上限：写盘累计超过清单标称体积的安全容差（max(+10MiB, 1.05x)）
 *       立即中止、删 .part、结构化报错——防资产被换/服务端异常时的无界写盘。
 *   （sha256 校验不可绕过的既有防线保持：下完必过 verifyOrDeleteFile。）
 */

import * as fs from 'node:fs';
import { isAllowedAssetUrl } from './update-core.js';
import { verifyOrDeleteFile } from './update-verify.js';

/** 下载进度推送节流（~250ms 一次，别刷爆 IPC）。 */
const PROGRESS_THROTTLE_MS = 250;
/** 体积硬上限的绝对余量（10 MiB）。 */
const SIZE_MARGIN_BYTES = 10 * 1024 * 1024;

/**
 * M1：允许写盘的最大字节数 = max(标称 + 10MiB, 标称 × 1.05)。
 * 小包用绝对余量兜底（content-length 与清单的正常抖动不至误杀），
 * 大包用比例余量。导出供单测直接验公式。
 */
export function maxAllowedBytes(expectedSize: number): number {
  return Math.max(expectedSize + SIZE_MARGIN_BYTES, Math.ceil(expectedSize * 1.05));
}

/** fetch 响应的最小结构（真 fetch 的 Response 天然满足；测试可手工构造）。 */
export interface DownloadResponseLike {
  ok: boolean;
  status: number;
  /** 跟随重定向后的**最终** URL；空串（如测试 mock）时回退请求 URL。 */
  url: string;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

/** 可注入的 fetch 形状（生产用全局 fetch，测试注入 mock）。 */
export type FetchLike = (
  url: string,
  init: {
    signal: AbortSignal;
    redirect: 'follow';
    headers: Record<string, string>;
  },
) => Promise<DownloadResponseLike>;

export interface DownloadJob {
  url: string;
  /** 显式配置的 HTTPS 镜像精确同源；默认仅放行 GitHub 资产域。 */
  allowedAssetOrigins?: readonly string[];
  expectedSha256: string;
  /** 清单标称体积（进度 total 兜底 + M1 硬上限基数）。 */
  expectedSize: number;
  partPath: string;
  finalPath: string;
  signal: AbortSignal;
  /** 已节流的进度回调（transferred/total 字节）。 */
  onProgress(transferred: number, total: number): void;
  fetchImpl?: FetchLike;
  /** 进度节流间隔覆盖（仅测试注入 0 以断言每帧）。 */
  throttleMs?: number;
  /** M1 上限覆盖（仅测试注入小值以触发中止路径；生产走 maxAllowedBytes）。 */
  maxBytes?: number;
}

export type DownloadOutcome =
  | { ok: true; filePath: string }
  | { ok: false; cancelled?: boolean; error: string };

/** 写一个 chunk 并等它落盘（借 write 回调自然串行，避免写缓冲无界膨胀）。 */
function writeChunk(stream: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/** 关闭写流（end 完成后 resolve）。 */
function endStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(() => resolve()));
}

/**
 * 流式下载到 .part → sha256 校验（不匹配删文件报错）→ 改名落位 finalPath。
 * 所有失败路径都清理 .part 并返回结构化错误，不抛裸异常。
 */
export async function downloadToFile(job: DownloadJob): Promise<DownloadOutcome> {
  const fetchImpl: FetchLike = job.fetchImpl ?? fetch;
  const throttleMs = job.throttleMs ?? PROGRESS_THROTTLE_MS;
  const limit = job.maxBytes ?? maxAllowedBytes(job.expectedSize);
  let out: fs.WriteStream | null = null;

  /** 失败路径统一清理：关流 + 删 .part（best-effort）。 */
  const cleanup = async (): Promise<void> => {
    if (out) {
      await endStream(out).catch(() => undefined);
      out = null;
    }
    await fs.promises.rm(job.partPath, { force: true }).catch(() => undefined);
  };

  try {
    const res = await fetchImpl(job.url, {
      signal: job.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'otto-desktop-updater' },
    });
    if (!res.ok || !res.body) {
      return { ok: false, error: `下载失败：更新源返回 HTTP ${res.status}` };
    }
    // H1：重定向后的最终 URL 必须仍在 GitHub 白名单或显式镜像同源内，
    // 否则一个字节都不写盘。
    // res.url 为空（非标准实现/测试 mock）时回退请求 URL 判定。
    const finalUrl = res.url || job.url;
    if (!isAllowedAssetUrl(finalUrl, job.allowedAssetOrigins)) {
      return {
        ok: false,
        error: `下载被重定向到允许名单之外的地址（${finalUrl}），已拒绝写盘`,
      };
    }

    const contentLength = Number(res.headers.get('content-length') ?? '');
    const total =
      Number.isFinite(contentLength) && contentLength > 0
        ? contentLength
        : job.expectedSize;

    out = fs.createWriteStream(job.partPath);
    const reader = res.body.getReader();
    let transferred = 0;
    let lastPushAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      transferred += value.byteLength;
      // M1：超过清单标称体积的安全上限 → 立即中止 + 清理，防无界写盘。
      if (transferred > limit) {
        await reader.cancel().catch(() => undefined);
        await cleanup();
        return {
          ok: false,
          error:
            `下载数据量已超过清单标称体积的安全上限（已收 ${transferred} 字节，` +
            `标称 ${job.expectedSize} 字节，上限 ${limit} 字节），已中止并删除临时文件`,
        };
      }
      await writeChunk(out, value);
      const now = Date.now();
      if (now - lastPushAt >= throttleMs) {
        lastPushAt = now;
        job.onProgress(transferred, total);
      }
    }
    await endStream(out);
    out = null;
    // 收尾必推一帧 100%，确保 UI 不停在 9x%。
    job.onProgress(transferred, Math.max(total, transferred));

    // sha256 校验：唯一完整性防线，不匹配 → verifyOrDeleteFile 删 .part 并报错。
    const verified = await verifyOrDeleteFile(job.partPath, job.expectedSha256);
    if (!verified.ok) {
      return { ok: false, error: verified.error };
    }
    // 校验通过才落正式名（覆盖同名旧文件——能走到这里说明旧文件 sha256 不匹配）。
    await fs.promises.rm(job.finalPath, { force: true });
    await fs.promises.rename(job.partPath, job.finalPath);
    return { ok: true, filePath: job.finalPath };
  } catch (e) {
    const cancelled = e instanceof Error && e.name === 'AbortError';
    await cleanup();
    if (cancelled) {
      return { ok: false, cancelled: true, error: '下载已取消' };
    }
    return {
      ok: false,
      error:
        '下载中断（中国大陆直连 GitHub 可能较慢或不通，可重试或配置代理）：' +
        (e instanceof Error ? e.message : String(e)),
    };
  }
}
