/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom-model types & helpers — webview-local copy.
 *
 * The full core package (`otto-core`) imports Node built-ins (fs / path /
 * os / undici / @grpc) which webpack can't bundle for the webview's `target:
 * 'web'` output. We can't externalize core either because the extension host
 * already does that on its side.
 *
 * So this file is a hand-maintained mirror of the *pure-JS* surface of
 * `packages/core/src/types/customModel.ts` that the webview wizard needs:
 *   - Types: CustomModelProvider, CustomModelConfig, EasyRouterModelEntry,
 *     EasyClawModelMetadata
 *   - Constants: EASY_ROUTER_BASE_URL, EASY_ROUTER_DEFAULT_MAX_TOKENS
 *   - Pure helpers: validateCustomModelConfig, classifyEasyRouterModel,
 *     buildEasyRouterModelConfig
 *
 * Keep this in lockstep with the canonical core file. The two paths share a
 * single on-disk format (`~/.deepv/custom-models.json`), so any structural
 * change must update both sides.
 */

export type CustomModelProvider =
  | 'openai'
  | 'openai-responses'
  | 'anthropic'
  | 'gemini';

export interface CustomModelConfig {
  displayName: string;
  provider: CustomModelProvider;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  /** Context window size (input + output combined). Typically 100K–1M. */
  maxTokens?: number;
  /**
   * Hard cap on output tokens per response (Anthropic `max_tokens` /
   * OpenAI Responses `max_output_tokens`). Typically 4K–64K. Distinct from
   * the context window — Anthropic rejects requests where max_tokens
   * exceeds the model's output cap, so blindly sending the 1M context
   * window will 400.
   */
  maxOutputTokens?: number;
  enabled?: boolean;
  headers?: Record<string, string>;
  timeout?: number;
  // Optional thinking override; the wizard doesn't surface it but we forward
  // anything already present from disk so we don't drop user-edited config.
  thinking?: { mode?: 'on' | 'off' | 'auto'; effort?: string; budgetTokens?: number };
}

export interface EasyRouterModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
  supported_endpoint_types?: string[];
}

export interface EasyClawModelMetadata {
  model_id: string;
  display_name?: string;
  /** Maximum context window (tokens). */
  max_context_length?: number;
  /**
   * Maximum output length (tokens) — the per-response output cap.
   * NOTE: API uses `max_output_length`, not `max_output_tokens`. Verified
   * via curl https://easyclaw.work/api/models on 2026-05-26.
   */
  max_output_length?: number;
  description?: string;
  // Other fields exist on the wire (provider/pricing/etc.) but the wizard
  // only consumes max_context_length / max_output_length, so we leave
  // the rest open.
  [extra: string]: unknown;
}

export const EASY_ROUTER_BASE_URL = 'https://llm-endpoint.net/v1';
export const EASY_ROUTER_DEFAULT_MAX_TOKENS = 200_000;

/**
 * Validate a single custom-model config. Returns a list of human-readable
 * error strings (empty array means OK). Keep field-by-field error messages
 * matching the core implementation so users see consistent text whether they
 * configured via CLI or the VSCode wizard.
 */
export function validateCustomModelConfig(config: CustomModelConfig): string[] {
  const errors: string[] = [];

  if (!config.displayName || typeof config.displayName !== 'string') {
    errors.push('displayName is required and must be a string');
  }

  if (
    !config.provider ||
    (config.provider !== 'openai' &&
      config.provider !== 'openai-responses' &&
      config.provider !== 'anthropic' &&
      config.provider !== 'gemini')
  ) {
    errors.push('provider must be one of: openai, openai-responses, anthropic, gemini');
  }

  if (!config.baseUrl || typeof config.baseUrl !== 'string') {
    errors.push('baseUrl is required and must be a string');
  } else if (!config.baseUrl.startsWith('http://') && !config.baseUrl.startsWith('https://')) {
    errors.push('baseUrl must start with http:// or https://');
  }

  if (!config.apiKey || typeof config.apiKey !== 'string') {
    errors.push('apiKey is required and must be a string');
  }

  if (!config.modelId || typeof config.modelId !== 'string') {
    errors.push('modelId is required and must be a string');
  }

  if (
    config.maxTokens !== undefined &&
    (typeof config.maxTokens !== 'number' || config.maxTokens <= 0)
  ) {
    errors.push('maxTokens must be a positive number if specified');
  }

  if (
    config.maxOutputTokens !== undefined &&
    (typeof config.maxOutputTokens !== 'number' || config.maxOutputTokens <= 0)
  ) {
    errors.push('maxOutputTokens must be a positive number if specified');
  }

  if (
    config.timeout !== undefined &&
    (typeof config.timeout !== 'number' || config.timeout <= 0)
  ) {
    errors.push('timeout must be a positive number if specified');
  }

  return errors;
}

/**
 * Classify an EasyRouter model id into the right protocol — same rules as
 * the core implementation:
 *   - 'gemini*'  → 'gemini'  (native Google GenAI)
 *   - 'gpt*'     → 'openai-responses' (Responses API for gpt-5.x family)
 *   - 'claude*'  → 'anthropic'
 *   - other      → 'openai'  (Chat Completions, with vendor-aware thinking dispatch)
 */
export function classifyEasyRouterModel(modelId: string): CustomModelProvider {
  const id = (modelId ?? '').trim().toLowerCase();
  if (id.startsWith('gemini')) return 'gemini';
  if (id.startsWith('gpt')) return 'openai-responses';
  if (id.startsWith('claude')) return 'anthropic';
  return 'openai';
}

/**
 * Build a persistable CustomModelConfig from one EasyRouter model id + the
 * user's API key. Mirrors `buildEasyRouterModelConfig` in core:
 *   - displayName defaults to modelId
 *   - baseUrl is the fixed EasyRouter endpoint
 *   - maxTokens precedence: explicit > metadata.max_context_length > 200K default
 *   - maxOutputTokens precedence: explicit > metadata.max_output_length > undefined
 *     (intentionally NO numeric default here — 200K context-window default
 *     would blow past every Anthropic/OpenAI output cap and trigger 400s.
 *     Leave it undefined so the adapter falls back to its 32K hardcoded
 *     default; see customModelAdapter.ts DEFAULT_MAX_OUTPUT_TOKENS.)
 */
export function buildEasyRouterModelConfig(
  modelId: string,
  apiKey: string,
  options?: {
    displayName?: string;
    maxTokens?: number;
    maxOutputTokens?: number;
    metadata?: EasyClawModelMetadata;
  },
): CustomModelConfig {
  const provider = classifyEasyRouterModel(modelId);
  const explicit =
    typeof options?.maxTokens === 'number' && options.maxTokens > 0
      ? options.maxTokens
      : undefined;
  const fromMetadata =
    typeof options?.metadata?.max_context_length === 'number' &&
    (options.metadata.max_context_length as number) > 0
      ? (options.metadata.max_context_length as number)
      : undefined;
  const resolvedMaxTokens =
    explicit ?? fromMetadata ?? EASY_ROUTER_DEFAULT_MAX_TOKENS;

  const explicitOutput =
    typeof options?.maxOutputTokens === 'number' && options.maxOutputTokens > 0
      ? options.maxOutputTokens
      : undefined;
  const fromMetadataOutput =
    typeof options?.metadata?.max_output_length === 'number' &&
    (options.metadata.max_output_length as number) > 0
      ? (options.metadata.max_output_length as number)
      : undefined;
  const resolvedMaxOutputTokens = explicitOutput ?? fromMetadataOutput;

  return {
    displayName: options?.displayName?.trim() || modelId,
    provider,
    baseUrl: EASY_ROUTER_BASE_URL,
    apiKey,
    modelId,
    maxTokens: resolvedMaxTokens,
    ...(resolvedMaxOutputTokens !== undefined ? { maxOutputTokens: resolvedMaxOutputTokens } : {}),
    enabled: true,
  };
}
