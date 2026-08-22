import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/retry.js', () => ({
  retryWithBackoff: async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      return await fn();
    }
  },
}));

import { OttoServerAdapter } from './OttoServerAdapter.js';
import { proxyAuthManager } from './proxyAuth.js';

interface AdapterInternals {
  callUnifiedChatAPI(
    endpoint: string,
    requestBody: unknown,
    abortSignal?: AbortSignal,
    sceneType?: string,
  ): Promise<unknown>;
  callStreamAPI(
    endpoint: string,
    requestBody: unknown,
    abortSignal?: AbortSignal,
    sceneType?: string,
  ): Promise<Response>;
}

function requestIds(fetchMock: ReturnType<typeof vi.fn>, callIndex: number) {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  const headers = new Headers(init?.headers);
  return {
    canonical: headers.get('Idempotency-Key'),
    otto: headers.get('x-otto-idempotency-key'),
    request: headers.get('x-otto-request-id'),
  };
}

describe('OttoServerAdapter billing idempotency', () => {
  beforeEach(() => {
    vi.spyOn(proxyAuthManager, 'getUserHeaders').mockResolvedValue({});
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reuses one idempotency key across non-stream retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ candidates: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OttoServerAdapter(
      'test',
      'test',
      'https://proxy.example.test',
    ) as unknown as AdapterInternals;

    await adapter.callUnifiedChatAPI('/v1/chat/unified', {
      model: 'test-model',
      config: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = requestIds(fetchMock, 0);
    const second = requestIds(fetchMock, 1);
    expect(first.canonical).toMatch(
      /^otto-model-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(first).toEqual({
      canonical: first.canonical,
      otto: first.canonical,
      request: first.canonical,
    });
    expect(second).toEqual(first);
  });

  it('reuses one idempotency key across stream connection retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
      .mockResolvedValueOnce(
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new OttoServerAdapter(
      'test',
      'test',
      'https://proxy.example.test',
    ) as unknown as AdapterInternals;

    await adapter.callStreamAPI('/v1/chat/stream', {
      model: 'test-model',
      config: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = requestIds(fetchMock, 0);
    const second = requestIds(fetchMock, 1);
    expect(first.canonical).toBeTruthy();
    expect(first).toEqual({
      canonical: first.canonical,
      otto: first.canonical,
      request: first.canonical,
    });
    expect(second).toEqual(first);
  });
});
