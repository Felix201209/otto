/**
 * @license
 * Copyright 2026 Easy Code team
 * https://github.com/OrionStarAI/DeepVCode
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EASY_ROUTER_BASE_URL,
  type EasyRouterModelEntry,
  filterEasyRouterModels,
} from 'otto-core';

/**
 * Default timeout for the /v1/models request.
 * The endpoint is normally fast (<1s); 15s is a generous ceiling that still
 * keeps the wizard responsive on flaky networks.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Shape of a `/v1/models` success response from EasyRouter.
 * We only depend on `data: EasyRouterModelEntry[]`; other fields are tolerated.
 */
interface EasyRouterModelsResponse {
  data?: EasyRouterModelEntry[];
  object?: string;
  success?: boolean;
}

export interface FetchEasyRouterModelsOptions {
  /** Override the base URL (mainly for testing). Defaults to EASY_ROUTER_BASE_URL. */
  baseUrl?: string;
  /** Timeout in milliseconds. Default 15s. */
  timeoutMs?: number;
  /** Optional AbortSignal merged with the internal timeout signal. */
  signal?: AbortSignal;
}

/**
 * Error thrown when the EasyRouter `/v1/models` call fails for any reason.
 * Carries the HTTP status (when available) so the UI can render a useful
 * message: 401 → bad key, 429 → rate-limited, 5xx → upstream issue.
 */
export class EasyRouterFetchError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EasyRouterFetchError';
  }
}

/**
 * Fetch the list of usable models from EasyRouter, applying the standard
 * keyword filter (image / embed / video) and sorting by id.
 *
 * @param apiKey Bearer token to send in the Authorization header.
 *               The function trims whitespace but otherwise sends it as-is.
 * @returns Filtered & sorted list of {@link EasyRouterModelEntry}.
 * @throws  {EasyRouterFetchError} on network errors, non-2xx HTTP status,
 *          or malformed payload.
 */
export async function fetchEasyRouterModels(
  apiKey: string,
  options: FetchEasyRouterModelsOptions = {},
): Promise<EasyRouterModelEntry[]> {
  const trimmedKey = (apiKey ?? '').trim();
  if (!trimmedKey) {
    throw new EasyRouterFetchError('API key is required');
  }

  const baseUrl = (options.baseUrl ?? EASY_ROUTER_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/models`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(
    () => timeoutController.abort(new Error(`Timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  // Compose internal timeout signal with the optional caller signal.
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
        headers: {
          Authorization: `Bearer ${trimmedKey}`,
          Accept: 'application/json',
        },
        signal: composedSignal,
      });
    } catch (e) {
      if (timeoutController.signal.aborted) {
        throw new EasyRouterFetchError(
          `Request to ${url} timed out after ${timeoutMs}ms`,
          undefined,
          e,
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new EasyRouterFetchError(`Network error contacting ${url}: ${msg}`, undefined, e);
    }

    if (!response.ok) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        // ignore
      }
      const snippet = bodyText
        ? bodyText.length > 200
          ? bodyText.slice(0, 200) + '…'
          : bodyText
        : response.statusText || 'no body';
      throw new EasyRouterFetchError(
        `EasyRouter /models returned HTTP ${response.status}: ${snippet}`,
        response.status,
      );
    }

    let parsed: EasyRouterModelsResponse;
    try {
      parsed = (await response.json()) as EasyRouterModelsResponse;
    } catch (e) {
      throw new EasyRouterFetchError(
        'EasyRouter /models returned a body that is not valid JSON',
        response.status,
        e,
      );
    }

    if (!parsed || !Array.isArray(parsed.data)) {
      throw new EasyRouterFetchError(
        'EasyRouter /models response is missing the expected "data" array',
        response.status,
      );
    }

    return filterEasyRouterModels(parsed.data);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
