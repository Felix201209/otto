/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchEasyRouterModels,
  EasyRouterFetchError,
} from './easyRouterClient.js';

describe('fetchEasyRouterModels', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('rejects an empty api key without making a request', async () => {
    await expect(fetchEasyRouterModels('')).rejects.toBeInstanceOf(
      EasyRouterFetchError,
    );
    await expect(fetchEasyRouterModels('   ')).rejects.toBeInstanceOf(
      EasyRouterFetchError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a GET to /models with bearer auth and parses + filters the response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: 'list',
          success: true,
          data: [
            { id: 'gpt-image-2' },
            { id: 'claude-opus-4-7' },
            { id: 'gemini-2.5-flash' },
            { id: 'text-embedding-004' },
            { id: 'gpt-5.4' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const list = await fetchEasyRouterModels('  sk-test  ');
    expect(list.map((m) => m.id)).toEqual([
      'claude-opus-4-7',
      'gemini-2.5-flash',
      'gpt-5.4',
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://llm-endpoint.net/v1/models');
    expect((init as RequestInit).method).toBe('GET');
    const headers = (init as RequestInit).headers as Record<string, string>;
    // Trimmed bearer.
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers.Accept).toBe('application/json');
  });

  it('honours a custom baseUrl with trailing slashes stripped', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    await fetchEasyRouterModels('sk-x', {
      baseUrl: 'https://example.test/v1///',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/v1/models');
  });

  it('throws EasyRouterFetchError with status on HTTP 401', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid api key' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    let err: unknown;
    try {
      await fetchEasyRouterModels('sk-bad');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EasyRouterFetchError);
    expect((err as EasyRouterFetchError).status).toBe(401);
    expect((err as EasyRouterFetchError).message).toMatch(/HTTP 401/);
  });

  it('throws if the body is not valid JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('not-json', { status: 200 }),
    );

    await expect(fetchEasyRouterModels('sk-x')).rejects.toMatchObject({
      name: 'EasyRouterFetchError',
      status: 200,
    });
  });

  it('throws if response is missing the data array', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ object: 'list' }), { status: 200 }),
    );

    await expect(fetchEasyRouterModels('sk-x')).rejects.toMatchObject({
      name: 'EasyRouterFetchError',
      message: expect.stringMatching(/missing the expected "data" array/),
    });
  });

  it('wraps network errors in EasyRouterFetchError', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    let err: unknown;
    try {
      await fetchEasyRouterModels('sk-x');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EasyRouterFetchError);
    expect((err as EasyRouterFetchError).message).toMatch(/Network error/);
    expect((err as EasyRouterFetchError).status).toBeUndefined();
  });
});
