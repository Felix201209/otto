/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import type { CustomModelConfig } from '../types/customModel.js';
import {
  callOpenAICompatibleModel,
  callOpenAICompatibleModelStream,
  callOpenAIResponsesModel,
  callOpenAIResponsesModelStream,
} from './customModelOpenAIClient.js';

const request = {
  contents: [
    {
      role: MESSAGE_ROLES.USER,
      parts: [{ text: 'Hello' }],
    },
  ],
};

const chatResponse = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const responsesResponse = () =>
  new Response(
    JSON.stringify({
      id: 'resp_runtime_token',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Hello' }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const sseResponse = (events: string[]) =>
  new Response(`${events.map((event) => `data: ${event}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

function createConfig(
  provider: 'openai' | 'openai-responses',
  apiKeyProvider?: () => Promise<string>,
): CustomModelConfig {
  return {
    displayName: 'Otto managed model',
    provider,
    baseUrl: 'https://edge.example.test/v1',
    apiKey: 'byok-must-not-be-used',
    apiKeyProvider,
    modelId: 'otto:test-model',
  };
}

function authorizationOf(call: unknown[]): string | null {
  const init = call[1] as RequestInit;
  return new Headers(init.headers).get('authorization');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OpenAI runtime API token provider', () => {
  it.each([
    {
      name: 'chat unary',
      provider: 'openai' as const,
      response: chatResponse,
      invoke: async (config: CustomModelConfig) => {
        await callOpenAICompatibleModel(config, request);
      },
    },
    {
      name: 'chat stream',
      provider: 'openai' as const,
      response: () =>
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
        ]),
      invoke: async (config: CustomModelConfig) => {
        for await (const _chunk of callOpenAICompatibleModelStream(config, request)) {
          // Consume the stream so the request path completes.
        }
      },
    },
    {
      name: 'responses unary',
      provider: 'openai-responses' as const,
      response: responsesResponse,
      invoke: async (config: CustomModelConfig) => {
        await callOpenAIResponsesModel(config, request);
      },
    },
    {
      name: 'responses stream',
      provider: 'openai-responses' as const,
      response: () =>
        sseResponse([
          JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' }),
        ]),
      invoke: async (config: CustomModelConfig) => {
        for await (const _chunk of callOpenAIResponsesModelStream(config, request)) {
          // Consume the stream so the request path completes.
        }
      },
    },
  ])('uses a fresh runtime token for $name', async ({ provider, response, invoke }) => {
    const apiKeyProvider = vi.fn().mockResolvedValue('short-lived-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response());

    await invoke(createConfig(provider, apiKeyProvider));

    expect(apiKeyProvider).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(authorizationOf(fetchMock.mock.calls[0])).toBe(
      'Bearer short-lived-token',
    );
  });

  it('refreshes the runtime token before a retry attempt', async () => {
    vi.useFakeTimers();
    const apiKeyProvider = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('expired-token')
      .mockResolvedValueOnce('refreshed-token');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('temporary failure', { status: 500 }))
      .mockResolvedValueOnce(chatResponse());

    const result = callOpenAICompatibleModel(
      createConfig('openai', apiKeyProvider),
      request,
    );
    await vi.runAllTimersAsync();
    await result;

    expect(apiKeyProvider).toHaveBeenCalledTimes(2);
    expect(authorizationOf(fetchMock.mock.calls[0])).toBe('Bearer expired-token');
    expect(authorizationOf(fetchMock.mock.calls[1])).toBe('Bearer refreshed-token');
  });

  it('fails closed before fetch when the runtime token is empty', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const apiKeyProvider = vi.fn().mockResolvedValue('   ');

    await expect(
      callOpenAIResponsesModel(
        createConfig('openai-responses', apiKeyProvider),
        request,
      ),
    ).rejects.toThrow('Runtime API token provider returned an empty token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves static BYOK authorization when no provider is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(chatResponse());
    const config = createConfig('openai');
    config.apiKey = 'customer-byok-token';

    await callOpenAICompatibleModel(config, request);

    expect(authorizationOf(fetchMock.mock.calls[0])).toBe(
      'Bearer customer-byok-token',
    );
  });
});
