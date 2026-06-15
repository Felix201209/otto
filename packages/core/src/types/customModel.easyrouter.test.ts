/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  EASY_ROUTER_BASE_URL,
  EASY_ROUTER_EXCLUDE_KEYWORDS,
  EASY_ROUTER_DEFAULT_MAX_TOKENS,
  EASY_CLAW_METADATA_URL,
  shouldExcludeEasyRouterModel,
  filterEasyRouterModels,
  classifyEasyRouterModel,
  buildEasyRouterModelConfig,
  indexEasyClawMetadata,
  type EasyClawModelMetadata,
} from './customModel.js';

describe('EasyRouter integration', () => {
  describe('constants', () => {
    it('exposes the canonical EasyRouter base URL', () => {
      expect(EASY_ROUTER_BASE_URL).toBe('https://llm-endpoint.net/v1');
    });

    it('exposes the documented exclude keyword list', () => {
      expect([...EASY_ROUTER_EXCLUDE_KEYWORDS]).toEqual([
        'image',
        'embed',
        'video',
        'seedance',
        'seed',
        'veo',
        'tts',
      ]);
    });
  });

  describe('shouldExcludeEasyRouterModel', () => {
    it('excludes empty / non-string ids', () => {
      expect(shouldExcludeEasyRouterModel('')).toBe(true);
      // @ts-expect-error -- runtime guard test
      expect(shouldExcludeEasyRouterModel(undefined)).toBe(true);
      // @ts-expect-error -- runtime guard test
      expect(shouldExcludeEasyRouterModel(null)).toBe(true);
    });

    it('excludes ids containing image/embed/video, case-insensitive', () => {
      expect(shouldExcludeEasyRouterModel('gpt-image-2')).toBe(true);
      expect(shouldExcludeEasyRouterModel('GPT-IMAGE-2')).toBe(true);
      expect(shouldExcludeEasyRouterModel('gemini-2.5-flash-image')).toBe(true);
      expect(shouldExcludeEasyRouterModel('amazon.titan-embed-text-v2:0')).toBe(true);
      expect(shouldExcludeEasyRouterModel('text-embedding-004')).toBe(true);
    });

    it('excludes seedance / seed / veo video-generation families', () => {
      expect(shouldExcludeEasyRouterModel('dreamina-seedance-2-0')).toBe(true);
      expect(shouldExcludeEasyRouterModel('dreamina-seedance-2-0-fast')).toBe(true);
      expect(shouldExcludeEasyRouterModel('seed-2-0-pro-260328')).toBe(true);
      expect(shouldExcludeEasyRouterModel('seed-2-0-lite-260228')).toBe(true);
      expect(shouldExcludeEasyRouterModel('veo-3.1-generate-001')).toBe(true);
      expect(shouldExcludeEasyRouterModel('veo-3.1-fast-generate-001')).toBe(true);
      expect(shouldExcludeEasyRouterModel('VEO-x')).toBe(true);
    });

    it('excludes tts / TTS speech-synthesis families', () => {
      expect(shouldExcludeEasyRouterModel('gemini-2.5-flash-tts')).toBe(true);
      expect(shouldExcludeEasyRouterModel('gpt-4o-mini-tts')).toBe(true);
      expect(shouldExcludeEasyRouterModel('Gemini-2.5-Pro-TTS')).toBe(true);
      expect(shouldExcludeEasyRouterModel('claude-tts-experimental')).toBe(true);
    });

    it('does not exclude regular text/chat models', () => {
      expect(shouldExcludeEasyRouterModel('claude-opus-4-7')).toBe(false);
      expect(shouldExcludeEasyRouterModel('gpt-5.4')).toBe(false);
      expect(shouldExcludeEasyRouterModel('gemini-2.5-flash')).toBe(false);
      expect(shouldExcludeEasyRouterModel('deepseek-v4-pro')).toBe(false);
      expect(shouldExcludeEasyRouterModel('kimi-k2.6')).toBe(false);
      expect(shouldExcludeEasyRouterModel('MiniMax-M2.7')).toBe(false);
    });
  });

  describe('filterEasyRouterModels', () => {
    it('matches the expected output for the real /v1/models payload sample', () => {
      // Subset taken verbatim from the production /v1/models response,
      // including the entries we want to keep AND the ones we want to drop.
      const raw = [
        { id: 'amazon.titan-embed-text-v2:0' },
        { id: 'claude-haiku-4-5' },
        { id: 'claude-opus-4-7' },
        { id: 'claude-sonnet-4-6' },
        { id: 'deepseek-v4-pro' },
        { id: 'dreamina-seedance-2-0' },
        { id: 'gemini-2.5-flash' },
        { id: 'gemini-2.5-flash-image' },
        { id: 'gemini-3.1-flash-image-preview' },
        { id: 'gemini-embedding-001' },
        { id: 'glm-5' },
        { id: 'gpt-5.2' },
        { id: 'gpt-image-2' },
        { id: 'kimi-k2.6' },
        { id: 'MiniMax-M2.7' },
        { id: 'qwen3.7-max' },
        { id: 'text-embedding-004' },
        { id: 'veo-3.1-fast-generate-001' },
        { id: 'gemini-2.5-flash-tts' },
        { id: 'gpt-4o-mini-tts' },
      ];

      const filtered = filterEasyRouterModels(raw);
      const ids = filtered.map((m) => m.id);

      // Sorted by localeCompare (case-insensitive) ascending, no
      // image/embed/video/seedance/seed/veo/tts entries.
      expect(ids).toEqual([
        'claude-haiku-4-5',
        'claude-opus-4-7',
        'claude-sonnet-4-6',
        'deepseek-v4-pro',
        'gemini-2.5-flash',
        'glm-5',
        'gpt-5.2',
        'kimi-k2.6',
        'MiniMax-M2.7',
        'qwen3.7-max',
      ]);
    });

    it('strips null/undefined/non-object entries', () => {
      const raw = [null, undefined, 42, { id: 42 }, { id: '' }, { id: 'gpt-5.4' }] as Array<unknown>;
      const filtered = filterEasyRouterModels(raw as never);
      expect(filtered.map((m) => m.id)).toEqual(['gpt-5.4']);
    });

    it('deduplicates entries with the same id', () => {
      const raw = [
        { id: 'gpt-5.4' },
        { id: 'gpt-5.4', owned_by: 'something' },
        { id: 'claude-opus-4-7' },
      ];
      const filtered = filterEasyRouterModels(raw);
      expect(filtered.map((m) => m.id)).toEqual(['claude-opus-4-7', 'gpt-5.4']);
    });

    it('returns [] for null/undefined input', () => {
      expect(filterEasyRouterModels(undefined as never)).toEqual([]);
      expect(filterEasyRouterModels(null as never)).toEqual([]);
    });
  });

  describe('classifyEasyRouterModel', () => {
    it('routes gpt* to openai-responses', () => {
      expect(classifyEasyRouterModel('gpt-5.4')).toBe('openai-responses');
      expect(classifyEasyRouterModel('GPT-5.4-mini')).toBe('openai-responses');
      expect(classifyEasyRouterModel('gpt-5.1-codex')).toBe('openai-responses');
    });

    it('routes claude* to anthropic', () => {
      expect(classifyEasyRouterModel('claude-opus-4-7')).toBe('anthropic');
      expect(classifyEasyRouterModel('CLAUDE-haiku-4-5')).toBe('anthropic');
    });

    it('routes Gemini ids to native GenAI provider', () => {
      expect(classifyEasyRouterModel('gemini-2.5-pro')).toBe('gemini');
      expect(classifyEasyRouterModel('gemini-2.5-flash')).toBe('gemini');
      expect(classifyEasyRouterModel('GEMINI-3.5-flash')).toBe('gemini');
      expect(classifyEasyRouterModel('gemini-3.1-pro-preview')).toBe('gemini');
    });

    it('falls back to plain "openai" for everything else', () => {
      expect(classifyEasyRouterModel('deepseek-v4-pro')).toBe('openai');
      expect(classifyEasyRouterModel('kimi-k2.6')).toBe('openai');
      expect(classifyEasyRouterModel('MiniMax-M2.7')).toBe('openai');
      expect(classifyEasyRouterModel('qwen3.7-max')).toBe('openai');
      expect(classifyEasyRouterModel('glm-5')).toBe('openai');
    });

    it('handles whitespace and empty input safely', () => {
      expect(classifyEasyRouterModel('  gpt-5.4  ')).toBe('openai-responses');
      expect(classifyEasyRouterModel('')).toBe('openai');
      // @ts-expect-error -- runtime guard test
      expect(classifyEasyRouterModel(undefined)).toBe('openai');
    });
  });

  describe('buildEasyRouterModelConfig', () => {
    it('falls back to the 200K default maxTokens when no metadata / override is given', () => {
      expect(EASY_ROUTER_DEFAULT_MAX_TOKENS).toBe(200_000);
      const cfg = buildEasyRouterModelConfig('claude-opus-4-7', 'sk-test');
      expect(cfg).toEqual({
        displayName: 'claude-opus-4-7',
        provider: 'anthropic',
        baseUrl: EASY_ROUTER_BASE_URL,
        apiKey: 'sk-test',
        modelId: 'claude-opus-4-7',
        maxTokens: EASY_ROUTER_DEFAULT_MAX_TOKENS,
        enabled: true,
      });
    });

    it('respects displayName / maxTokens overrides', () => {
      const cfg = buildEasyRouterModelConfig('gpt-5.4', 'sk-test', {
        displayName: '  My GPT  ',
        maxTokens: 256_000,
      });
      expect(cfg.displayName).toBe('My GPT');
      expect(cfg.maxTokens).toBe(256_000);
      expect(cfg.provider).toBe('openai-responses');
      expect(cfg.modelId).toBe('gpt-5.4');
    });

    it('falls back to modelId when displayName is whitespace', () => {
      const cfg = buildEasyRouterModelConfig('kimi-k2.6', 'sk-test', {
        displayName: '   ',
      });
      expect(cfg.displayName).toBe('kimi-k2.6');
    });

    it('auto-fills maxTokens from EasyClaw metadata.max_context_length', () => {
      const meta: EasyClawModelMetadata = {
        model_id: 'gpt-5.4',
        display_name: 'GPT-5.4 1M',
        max_context_length: 1_000_000,
        max_output_length: 100_000,
      };
      const cfg = buildEasyRouterModelConfig('gpt-5.4', 'sk-test', {
        metadata: meta,
      });
      // displayName intentionally stays as model_id (user preference).
      expect(cfg.displayName).toBe('gpt-5.4');
      expect(cfg.maxTokens).toBe(1_000_000);
      expect(cfg.provider).toBe('openai-responses');
    });

    it('explicit maxTokens override beats metadata', () => {
      const cfg = buildEasyRouterModelConfig('gpt-5.4', 'sk-test', {
        maxTokens: 256_000,
        metadata: { model_id: 'gpt-5.4', max_context_length: 1_000_000 },
      });
      expect(cfg.maxTokens).toBe(256_000);
    });

    it('falls back to the 200K default when metadata has zero / negative context length', () => {
      const cfg = buildEasyRouterModelConfig('claude-haiku-4-5', 'sk-test', {
        metadata: { model_id: 'claude-haiku-4-5', max_context_length: 0 },
      });
      expect(cfg.maxTokens).toBe(EASY_ROUTER_DEFAULT_MAX_TOKENS);
    });

    it('does NOT set maxOutputTokens when no metadata / override is given', () => {
      // Adapter should pick a provider-appropriate default; we must not
      // pre-fill 200K (the context-window default), or every Anthropic
      // request will 400 with "max_tokens too high".
      const cfg = buildEasyRouterModelConfig('claude-opus-4-7', 'sk-test');
      expect(cfg.maxOutputTokens).toBeUndefined();
    });

    it('auto-fills maxOutputTokens from EasyClaw metadata.max_output_length', () => {
      const cfg = buildEasyRouterModelConfig('claude-sonnet-4-20250514', 'sk-test', {
        metadata: {
          model_id: 'claude-sonnet-4-20250514',
          max_context_length: 1_000_000,
          max_output_length: 32_000,
        },
      });
      expect(cfg.maxTokens).toBe(1_000_000);     // context window
      expect(cfg.maxOutputTokens).toBe(32_000);  // output cap
    });

    it('explicit maxOutputTokens override beats metadata', () => {
      const cfg = buildEasyRouterModelConfig('claude-sonnet-4-20250514', 'sk-test', {
        maxOutputTokens: 8_192,
        metadata: {
          model_id: 'claude-sonnet-4-20250514',
          max_output_length: 32_000,
        },
      });
      expect(cfg.maxOutputTokens).toBe(8_192);
    });

    it('omits maxOutputTokens when metadata has zero / negative output length', () => {
      const cfg = buildEasyRouterModelConfig('gpt-5.4', 'sk-test', {
        metadata: { model_id: 'gpt-5.4', max_output_length: 0 },
      });
      expect(cfg.maxOutputTokens).toBeUndefined();
    });
  });

  describe('EasyClaw metadata helpers', () => {
    it('exposes the canonical EasyClaw metadata URL', () => {
      expect(EASY_CLAW_METADATA_URL).toBe(
        'https://api.easyclaw.work/api/v1/public-model-list',
      );
    });

    it('indexEasyClawMetadata builds a model_id → entry map', () => {
      const list: EasyClawModelMetadata[] = [
        {
          model_id: 'gpt-5.4',
          max_context_length: 1_000_000,
          max_output_length: 100_000,
        },
        { model_id: 'claude-opus-4-7', max_context_length: 1_000_000 },
      ];
      const idx = indexEasyClawMetadata(list);
      expect(idx.size).toBe(2);
      expect(idx.get('gpt-5.4')?.max_output_length).toBe(100_000);
      expect(idx.get('missing-id')).toBeUndefined();
    });

    it('indexEasyClawMetadata tolerates null/undefined/garbage entries', () => {
      const idx = indexEasyClawMetadata([
        null,
        undefined,
        42 as unknown as EasyClawModelMetadata,
        { model_id: '' },
        { model_id: 'gpt-5.4' },
      ] as Array<EasyClawModelMetadata | null>);
      expect(idx.size).toBe(1);
      expect(idx.has('gpt-5.4')).toBe(true);
    });

    it('indexEasyClawMetadata returns empty map for null/undefined input', () => {
      expect(indexEasyClawMetadata(null).size).toBe(0);
      expect(indexEasyClawMetadata(undefined).size).toBe(0);
    });
  });
});
