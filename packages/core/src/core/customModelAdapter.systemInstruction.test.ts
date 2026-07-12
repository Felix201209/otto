/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import {
  callAnthropicModel,
  callAnthropicModelStream,
  callOpenAICompatibleModel,
  callOpenAICompatibleModelStream,
  callOpenAIResponsesModel,
  callOpenAIResponsesModelStream,
} from './customModelAdapter.js';

const SYSTEM_INSTRUCTION =
  'You are Otto. Current Model: test-model. Do not claim another identity.';

const request = () => ({
  contents: [
    {
      role: MESSAGE_ROLES.USER,
      parts: [{ text: '你好' }],
    },
  ],
  config: { systemInstruction: SYSTEM_INSTRUCTION },
});

const openAIConfig = {
  provider: 'openai' as const,
  modelId: 'glm-test',
  baseUrl: 'https://openai-compatible.example/v1',
  apiKey: 'test-key',
  displayName: 'OpenAI-compatible test model',
};

const responsesConfig = {
  provider: 'openai-responses' as const,
  modelId: 'gpt-test',
  baseUrl: 'https://responses.example/v1',
  apiKey: 'test-key',
  displayName: 'Responses test model',
};

const anthropicConfig = {
  provider: 'anthropic' as const,
  modelId: 'claude-test',
  baseUrl: 'https://anthropic.example',
  apiKey: 'test-key',
  displayName: 'Anthropic test model',
  thinking: { mode: 'off' as const },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureJsonBody(responseBody: unknown): {
  captured: () => Record<string, unknown>;
} {
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { captured: () => body };
}

function captureStreamBody(streamBody: string): {
  captured: () => Record<string, unknown>;
} {
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(streamBody, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }),
  );
  return { captured: () => body };
}

describe('custom model systemInstruction forwarding', () => {
  it('forwards systemInstruction to OpenAI Chat unary requests', async () => {
    const body = captureJsonBody({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    await callOpenAICompatibleModel(openAIConfig, request());

    expect(body.captured().messages).toEqual([
      { role: 'system', content: SYSTEM_INSTRUCTION },
      { role: 'user', content: '你好' },
    ]);
  });

  it('forwards systemInstruction to OpenAI Chat streaming requests', async () => {
    const body = captureStreamBody('data: [DONE]\n\n');

    for await (const _chunk of callOpenAICompatibleModelStream(
      openAIConfig,
      request(),
    )) {
      // Consume the stream so the captured request represents the real path.
    }

    expect(body.captured().messages).toEqual([
      { role: 'system', content: SYSTEM_INSTRUCTION },
      { role: 'user', content: '你好' },
    ]);
  });

  it('forwards systemInstruction to OpenAI Responses API-key unary requests', async () => {
    const body = captureJsonBody({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await callOpenAIResponsesModel(responsesConfig, request());

    expect(body.captured().instructions).toBe(SYSTEM_INSTRUCTION);
  });

  it('forwards systemInstruction to OpenAI Responses API-key streaming requests', async () => {
    const body = captureStreamBody('data: [DONE]\n\n');

    for await (const _chunk of callOpenAIResponsesModelStream(
      responsesConfig,
      request(),
    )) {
      // Consume the stream so the captured request represents the real path.
    }

    expect(body.captured().instructions).toBe(SYSTEM_INSTRUCTION);
  });

  it('forwards systemInstruction to Anthropic unary requests', async () => {
    const body = captureJsonBody({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await callAnthropicModel(anthropicConfig, request());

    expect(body.captured().system).toEqual([
      {
        type: 'text',
        text: SYSTEM_INSTRUCTION,
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('forwards systemInstruction to Anthropic streaming requests', async () => {
    const body = captureStreamBody('');

    for await (const _chunk of callAnthropicModelStream(
      anthropicConfig,
      request(),
    )) {
      // Consume the stream so the captured request represents the real path.
    }

    expect(body.captured().system).toEqual([
      {
        type: 'text',
        text: SYSTEM_INSTRUCTION,
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });
});
