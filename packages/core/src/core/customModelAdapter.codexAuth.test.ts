/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getAuthHeaders: vi.fn(),
}));

vi.mock('./codexAuth.js', () => ({
  CodexAuthManager: {
    getInstance: () => ({ getAuthHeaders: auth.getAuthHeaders }),
  },
}));

import { MESSAGE_ROLES } from '../config/messageRoles.js';
import {
  callOpenAIResponsesModel,
  callOpenAIResponsesModelStream,
} from './customModelAdapter.js';

let tempDir: string;
let secretPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'otto-codex-oauth-'));
  secretPath = join(tempDir, 'codex-oauth');
  writeFileSync(secretPath, '${CODEX_OAUTH}\n', 'utf8');
  auth.getAuthHeaders.mockReset();
  auth.getAuthHeaders.mockResolvedValue({
    Authorization: 'Bearer oauth-test-token',
    'chatgpt-account-id': 'account-test',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tempDir, { recursive: true, force: true });
});

function modelConfig() {
  return {
    provider: 'openai-responses' as const,
    modelId: 'gpt-5.6-sol',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: `{file:${secretPath}}`,
    displayName: 'Codex (ChatGPT OAuth)',
  };
}

function request() {
  return {
    contents: [{ role: MESSAGE_ROLES.USER, parts: [{ text: '你好' }] }],
    config: {
      systemInstruction: { parts: [{ text: '你是 Otto。' }] },
    },
  };
}

function expectCodexRequest(init: RequestInit | undefined): void {
  const headers = new Headers(init?.headers);
  const body = JSON.parse(String(init?.body));
  expect(auth.getAuthHeaders).toHaveBeenCalledTimes(1);
  expect(headers.get('authorization')).toBe('Bearer oauth-test-token');
  expect(headers.get('chatgpt-account-id')).toBe('account-test');
  expect(body.instructions).toBe('你是 Otto。');
  expect(body).not.toHaveProperty('max_output_tokens');
}

describe('OpenAI Responses Codex OAuth 文件引用', () => {
  it('单次请求解析 {file:...} 后仍使用 Codex OAuth 头和请求体约束', async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = init;
        return new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: '完成' }] },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    await callOpenAIResponsesModel(modelConfig(), request());
    expectCodexRequest(captured);
  });

  it('流式请求解析 {file:...} 后仍使用 Codex OAuth 头和请求体约束', async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = init;
        return new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );

    for await (const _chunk of callOpenAIResponsesModelStream(
      modelConfig(),
      request(),
    )) {
      // 消费完整流，断言集中在捕获到的真实出网请求上。
    }
    expectCodexRequest(captured);
  });
});
