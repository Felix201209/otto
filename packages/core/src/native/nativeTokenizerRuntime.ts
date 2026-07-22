/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { NativeCoreBridge, type NativeCoreRuntimeSelection } from './nativeCoreBridge.js';

export type NativeTokenizerStatus = 'native' | 'fallback';

export interface NativeTokenizerRuntimeBridge {
  readonly selection: NativeCoreRuntimeSelection;
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface NativeTokenizerRuntimeOptions {
  bridge?: NativeTokenizerRuntimeBridge;
  model?: string;
}

export interface NativeTokenCountResult {
  status: NativeTokenizerStatus;
  tokens?: number;
}

export interface NativeTokenTruncateResult {
  status: NativeTokenizerStatus;
  text?: string;
}

function readNumberField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function readStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' ? raw : undefined;
}

function readStringArrayField(value: unknown, field: string): string[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return Array.isArray(raw) && raw.every((item) => typeof item === 'string') ? raw : undefined;
}

export class NativeTokenizerRuntime {
  private initializedModel?: string;
  private disabled = false;

  constructor(private readonly options: NativeTokenizerRuntimeOptions = {}) {}

  async count(text: string, model: string = this.options.model ?? 'gpt-4'): Promise<NativeTokenCountResult> {
    const ready = await this.ensureInitialized(model);
    if (!ready) return { status: 'fallback' };

    const result = await this.callNative('tokenizer.count', { text });
    const tokens = readNumberField(result, 'tokens');
    return tokens === undefined ? { status: 'fallback' } : { status: 'native', tokens };
  }

  async truncate(text: string, maxTokens: number, model: string = this.options.model ?? 'gpt-4'): Promise<NativeTokenTruncateResult> {
    const ready = await this.ensureInitialized(model);
    if (!ready) return { status: 'fallback' };

    const result = await this.callNative('tokenizer.truncate', {
      text,
      max_tokens: Math.max(1, Math.floor(maxTokens)),
    });
    const truncated = readStringField(result, 'text');
    return truncated === undefined ? { status: 'fallback' } : { status: 'native', text: truncated };
  }

  async supportedModels(): Promise<string[]> {
    const ready = await this.ensureBridgeAvailable();
    if (!ready) return [];

    const result = await this.callNative('tokenizer.supported_models');
    return readStringArrayField(result, 'models') ?? [];
  }

  private async ensureInitialized(model: string): Promise<boolean> {
    if (this.initializedModel === model) return true;
    const ready = await this.ensureBridgeAvailable();
    if (!ready) return false;

    await this.callNative('tokenizer.create', { model });
    this.initializedModel = model;
    return true;
  }

  private async ensureBridgeAvailable(): Promise<boolean> {
    if (this.disabled) return false;

    const selection = this.bridge.selection;
    if (!selection.enabled) {
      this.disabled = true;
      return false;
    }
    return true;
  }

  private async callNative(method: string, params?: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.bridge.call(method, params);
    } catch (error) {
      if (this.bridge.selection.required) throw error;
      this.disabled = true;
      return undefined;
    }
  }

  private get bridge(): NativeTokenizerRuntimeBridge {
    return this.options.bridge ?? DEFAULT_NATIVE_TOKENIZER_BRIDGE;
  }
}

const DEFAULT_NATIVE_TOKENIZER_BRIDGE = new NativeCoreBridge();
let defaultNativeTokenizerRuntime: NativeTokenizerRuntime | undefined;

export function getNativeTokenizerRuntime(): NativeTokenizerRuntime {
  defaultNativeTokenizerRuntime ??= new NativeTokenizerRuntime();
  return defaultNativeTokenizerRuntime;
}

export function resetNativeTokenizerRuntimeForTests(): void {
  defaultNativeTokenizerRuntime = undefined;
}

