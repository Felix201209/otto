/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchEasyClawMetadata } from './easyClawMetadataClient.js';

describe('fetchEasyClawMetadata', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('GETs the canonical EasyClaw URL and returns a model_id-keyed map', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          success: true,
          data: [
            {
              model_id: 'gpt-5.4',
              display_name: 'GPT-5.4 1M',
              max_context_length: 1_000_000,
              max_output_length: 100_000,
            },
            { model_id: 'claude-opus-4-7', max_context_length: 1_000_000 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const map = await fetchEasyClawMetadata();
    expect(map.size).toBe(2);
    expect(map.get('gpt-5.4')?.max_context_length).toBe(1_000_000);
    expect(map.get('claude-opus-4-7')?.max_context_length).toBe(1_000_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.easyclaw.work/api/v1/public-model-list');
    expect((init as RequestInit).method).toBe('GET');
  });

  it('returns an empty map when the response is not 2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('upstream blew up', { status: 500 }),
    );
    const map = await fetchEasyClawMetadata();
    expect(map.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns an empty map when the body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not-json', { status: 200 }));
    const map = await fetchEasyClawMetadata();
    expect(map.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns an empty map when the response is missing the data array', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    const map = await fetchEasyClawMetadata();
    expect(map.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns an empty map on network errors', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const map = await fetchEasyClawMetadata();
    expect(map.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('honours a custom URL', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await fetchEasyClawMetadata({ url: 'https://example.test/list' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/list');
  });
});
