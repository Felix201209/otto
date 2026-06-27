/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EASY_CLAW_METADATA_URL,
  type EasyClawModelMetadata,
  indexEasyClawMetadata,
} from 'otto-core';

const DEFAULT_TIMEOUT_MS = 10_000;

interface EasyClawMetadataResponse {
  code?: number;
  success?: boolean;
  data?: EasyClawModelMetadata[];
  message?: string;
  request_id?: string;
}

export interface FetchEasyClawMetadataOptions {
  /** Override the URL (mainly for testing). */
  url?: string;
  /** Timeout in milliseconds. Default 10s. */
  timeoutMs?: number;
  /** Optional caller-provided abort signal. */
  signal?: AbortSignal;
}

/**
 * Fetch the EasyClaw public model metadata list and return it as a
 * `Map<model_id, metadata>` for fast lookup by `EasyRouterModelEntry.id`.
 *
 * Failures (network, non-2xx, malformed JSON) are **swallowed** and an empty
 * map is returned — metadata is a *nice-to-have* for the EasyRouter wizard
 * (used to auto-fill `maxTokens`); the user must still be able to add models
 * even when api.easyclaw.work is unreachable.
 */
export async function fetchEasyClawMetadata(
  options: FetchEasyClawMetadataOptions = {},
): Promise<Map<string, EasyClawModelMetadata>> {
  const url = options.url ?? EASY_CLAW_METADATA_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(
    () => timeoutController.abort(new Error(`timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );

  const signals: AbortSignal[] = [timeoutController.signal];
  if (options.signal) signals.push(options.signal);
  const composedSignal =
    signals.length === 1
      ? signals[0]
      : (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any?.(signals) ??
        signals[0];

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: composedSignal,
      });
    } catch (e) {
      console.warn(
        `[EasyClaw] Failed to fetch model metadata from ${url}:`,
        e instanceof Error ? e.message : e,
      );
      return new Map();
    }

    if (!response.ok) {
      console.warn(
        `[EasyClaw] /public-model-list returned HTTP ${response.status}; falling back to empty metadata.`,
      );
      return new Map();
    }

    let parsed: EasyClawMetadataResponse;
    try {
      parsed = (await response.json()) as EasyClawMetadataResponse;
    } catch (e) {
      console.warn(
        '[EasyClaw] /public-model-list body is not valid JSON; falling back to empty metadata.',
        e,
      );
      return new Map();
    }

    if (!parsed || !Array.isArray(parsed.data)) {
      console.warn(
        '[EasyClaw] /public-model-list response missing "data" array; falling back to empty metadata.',
      );
      return new Map();
    }

    return indexEasyClawMetadata(parsed.data);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
