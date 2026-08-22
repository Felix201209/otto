/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { OttoServerAdapter } from './OttoServerAdapter.js';
import { proxyAuthManager } from './proxyAuth.js';
import {
  ModelRequestSafetyError,
  isValidModelRequestId,
} from './modelRequestSafety.js';

interface AdapterTestBoundary {
  callUnifiedChatAPI(
    endpoint: string,
    requestBody: object,
    abortSignal?: AbortSignal,
    sceneType?: string,
  ): Promise<GenerateContentResponse>;
}

describe('OttoServerAdapter request safety integration', () => {
  beforeEach(() => {
    vi.spyOn(proxyAuthManager, 'getUserHeaders').mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function subject(): AdapterTestBoundary {
    return new OttoServerAdapter('', '', 'https://edge.test') as unknown as AdapterTestBoundary;
  }

  it('reuses one canonical request id for a confirmed-not-sent retry', async () => {
    const notSent = Object.assign(new Error('network unreachable'), { code: 'ENETUNREACH' });
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(notSent)
      .mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const body = { model: 'otto-fast', contents: [], config: {} };

    await expect(subject().callUnifiedChatAPI('/v1/chat/messages', body))
      .resolves.toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const ids = fetchMock.mock.calls.map(([, init]) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('idempotency-key')).toBe(headers.get('x-otto-request-id'));
      return headers.get('x-otto-request-id');
    });
    expect(ids[0]).toBe(ids[1]);
    expect(isValidModelRequestId(ids[0])).toBe(true);
  });

  it.each([429, 503])('does not retry an HTTP %s outcome', async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('rejected', {
      status,
      headers: {
        'x-otto-provider-request-state': 'unknown_outcome',
        'x-otto-provider-request-id': `provider-${status}`,
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = subject().callUnifiedChatAPI(
      '/v1/chat/messages',
      { model: 'otto-fast', contents: [], config: {} },
    );

    await expect(result).rejects.toMatchObject({
      name: 'ModelRequestSafetyError',
      requestState: 'unknown_outcome',
      providerRequestId: `provider-${status}`,
    } satisfies Partial<ModelRequestSafetyError>);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
