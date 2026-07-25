/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import { app, type WebContents } from 'electron';
import { applyPatchUpdate } from './incremental-patch-updater.js';
import { readActiveRendererCssPatch, resolvePatchUpdateRoot } from './incremental-patch-store.js';
import { applyComponentUpdate } from './incremental-component-updater.js';
import type { IncrementalUpdateArtifact, IncrementalUpdateKind, IncrementalUpdateManifest } from './incremental-update-manifest.js';
import { parseIncrementalUpdateManifest } from './incremental-update-manifest.js';

const CHECK_TIMEOUT_MS = 15_000;
const ENV_MANIFEST_URL = 'OTTO_INCREMENTAL_UPDATE_MANIFEST_URL';

type FetchJsonResult =
  | { ok: true; json: unknown }
  | { ok: false; error: string; httpStatus?: number };

export interface IncrementalUpdateAvailableArtifact {
  id: string;
  kind: IncrementalUpdateKind;
  version: string;
  target: string;
  restart: IncrementalUpdateArtifact['restart'];
  rollbackSupported: boolean;
}

export type IncrementalUpdateCheckResult =
  | {
      status: 'available';
      appVersion: string;
      sourceCommit: string;
      publishedAt: string;
      artifacts: IncrementalUpdateAvailableArtifact[];
    }
  | { status: 'up-to-date'; appVersion: string }
  | { status: 'check-failed'; appVersion: string; message: string };

export type IncrementalUpdateApplyResult =
  | {
      ok: true;
      kind: 'patch';
      id: string;
      version: string;
      target: string;
      restart: IncrementalUpdateArtifact['restart'];
      artifactPath: string;
      runtimeApplied: boolean;
    }
  | {
      ok: true;
      kind: 'component';
      id: string;
      version: string;
      target: string;
      restart: IncrementalUpdateArtifact['restart'];
      artifactPath: string;
    }
  | {
      ok: false;
      unsupported?: boolean;
      cancelled?: boolean;
      error: string;
    };

function resolveIncrementalManifestUrl(candidate = process.env[ENV_MANIFEST_URL]): string | null {
  const value = candidate?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<FetchJsonResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'otto-desktop-incremental-updater',
        accept: 'application/json',
      },
    });
    if (!res.ok) return { ok: false, error: `增量更新源返回 HTTP ${res.status}`, httpStatus: res.status };
    try {
      return { ok: true, json: (await res.json()) as unknown };
    } catch {
      return { ok: false, error: '增量更新清单不是有效 JSON' };
    }
  } catch (error) {
    if (timedOut) return { ok: false, error: `检查增量更新超时（${Math.round(timeoutMs / 1000)}s 内无响应）` };
    return { ok: false, error: `无法连接增量更新源：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeArtifact(artifact: IncrementalUpdateArtifact): IncrementalUpdateAvailableArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind,
    version: artifact.version,
    target: artifact.target,
    restart: artifact.restart,
    rollbackSupported: artifact.rollback.supported,
  };
}

function compatibleArtifacts(manifest: IncrementalUpdateManifest, appVersion: string): IncrementalUpdateArtifact[] {
  return [...manifest.channels.patch, ...manifest.channels.kernel, ...manifest.channels.component]
    .filter((artifact) => artifact.compat.appVersion === appVersion);
}

export class IncrementalUpdateService {
  private lastManifest: IncrementalUpdateManifest | null = null;
  private allowedAssetOrigins: string[] = [];

  constructor(private readonly getWebContents?: () => WebContents | undefined) {}

  async checkForUpdates(manifestUrlOverride?: string): Promise<IncrementalUpdateCheckResult> {
    this.lastManifest = null;
    this.allowedAssetOrigins = [];
    const appVersion = app.getVersion();
    const manifestUrl = resolveIncrementalManifestUrl(manifestUrlOverride);
    if (!manifestUrl) {
      return {
        status: 'check-failed',
        appVersion,
        message: `未配置 ${ENV_MANIFEST_URL}，无法检查补丁/内核/组件增量更新`,
      };
    }

    const fetched = await fetchJson(manifestUrl, CHECK_TIMEOUT_MS);
    if (!fetched.ok) return { status: 'check-failed', appVersion, message: fetched.error };

    const parsed = parseIncrementalUpdateManifest(fetched.json);
    if (!parsed.ok) return { status: 'check-failed', appVersion, message: parsed.error };

    const artifacts = compatibleArtifacts(parsed.manifest, appVersion);
    if (artifacts.length === 0) return { status: 'up-to-date', appVersion };

    this.lastManifest = parsed.manifest;
    this.allowedAssetOrigins = [new URL(manifestUrl).origin];
    return {
      status: 'available',
      appVersion,
      sourceCommit: parsed.manifest.sourceCommit,
      publishedAt: parsed.manifest.publishedAt,
      artifacts: artifacts.map(summarizeArtifact),
    };
  }

  async applyUpdate(kind: IncrementalUpdateKind, id: string): Promise<IncrementalUpdateApplyResult> {
    const manifest = this.lastManifest;
    if (!manifest) {
      return { ok: false, error: '当前没有已检查通过的增量更新清单，请先检查更新' };
    }
    const appVersion = app.getVersion();
    const artifact = compatibleArtifacts(manifest, appVersion)
      .find((candidate) => candidate.kind === kind && candidate.id === id);
    if (!artifact) {
      return { ok: false, error: `未找到兼容的增量更新：${kind}/${id}` };
    }

    if (artifact.kind === 'kernel') {
      return {
        ok: false,
        unsupported: true,
        error: `${artifact.kind} 增量更新执行器尚未接入；当前版本支持 patch/component 增量更新`,
      };
    }

    if (artifact.kind === 'patch') {
      const result = await applyPatchUpdate({
        artifact,
        userDataPath: app.getPath('userData'),
        allowedAssetOrigins: this.allowedAssetOrigins,
      });
      if (!result.ok) return result;

      return {
        ok: true,
        kind: 'patch',
        id: result.record.id,
        version: result.record.version,
        target: result.record.target,
        restart: artifact.restart,
        artifactPath: result.receipt.installedArtifactPath,
        runtimeApplied: await this.applyActiveRendererPatches(),
      };
    }

    const result = await applyComponentUpdate({
      artifact,
      userDataPath: app.getPath('userData'),
      allowedAssetOrigins: this.allowedAssetOrigins,
    });
    if (!result.ok) return result;

    return {
      ok: true,
      kind: 'component',
      id: result.record.id,
      version: result.record.version,
      target: result.record.target,
      restart: artifact.restart,
      artifactPath: result.receipt.installedArtifactPath,
    };
  }

  async applyActiveRendererPatches(): Promise<boolean> {
    const webContents = this.getWebContents?.();
    if (!webContents || webContents.isDestroyed()) return false;
    const css = await readActiveRendererCssPatch(resolvePatchUpdateRoot(app.getPath('userData')));
    if (!css) return false;
    await webContents.insertCSS(css);
    return true;
  }
}
