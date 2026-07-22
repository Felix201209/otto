/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { NativeCoreBridge, type NativeCoreRuntimeSelection } from './nativeCoreBridge.js';

export type NativeSessionStoreStatus = 'native' | 'fallback';

export interface NativeSessionStoreRuntimeBridge {
  readonly selection: NativeCoreRuntimeSelection;
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface NativeSessionStoreRuntimeOptions {
  bridge?: NativeSessionStoreRuntimeBridge;
  path: string;
  cacheSize?: number;
}

export interface NativeSessionMessage {
  role: string;
  content: string;
  timestamp: number;
  metadata?: string;
}

export interface NativeSessionMeta {
  id: string;
  title: string;
  updated_at: number;
  message_count: number;
}

export interface NativeSessionData {
  meta: NativeSessionMeta;
  messages: NativeSessionMessage[];
}

export interface NativeSessionStoreResult<T> {
  status: NativeSessionStoreStatus;
  value?: T;
}

function readBooleanField(value: unknown, field: string): boolean | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'boolean' ? raw : undefined;
}

function readNumberField(value: unknown, field: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function isSessionData(value: unknown): value is NativeSessionData {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'meta' in value &&
    'messages' in value &&
    Array.isArray((value as NativeSessionData).messages),
  );
}

function isSessionMetaArray(value: unknown): value is NativeSessionMeta[] {
  return Array.isArray(value);
}

export class NativeSessionStoreRuntime {
  private opened = false;
  private disabled = false;

  constructor(private readonly options: NativeSessionStoreRuntimeOptions) {}

  async save(id: string, title: string, messages: NativeSessionMessage[]): Promise<NativeSessionStoreStatus> {
    const ready = await this.ensureOpened();
    if (!ready) return 'fallback';

    await this.callNative('session_store.save', { id, title, messages });
    return 'native';
  }

  async load(id: string): Promise<NativeSessionStoreResult<NativeSessionData | null>> {
    const ready = await this.ensureOpened();
    if (!ready) return { status: 'fallback' };

    const result = await this.callNative('session_store.load', { id });
    if (result === null) return { status: 'native', value: null };
    return isSessionData(result) ? { status: 'native', value: result } : { status: 'fallback' };
  }

  async delete(id: string): Promise<NativeSessionStoreResult<boolean>> {
    const ready = await this.ensureOpened();
    if (!ready) return { status: 'fallback' };

    const result = await this.callNative('session_store.delete', { id });
    const deleted = readBooleanField(result, 'deleted');
    return deleted === undefined ? { status: 'fallback' } : { status: 'native', value: deleted };
  }

  async list(): Promise<NativeSessionStoreResult<NativeSessionMeta[]>> {
    const ready = await this.ensureOpened();
    if (!ready) return { status: 'fallback' };

    const result = await this.callNative('session_store.list');
    return isSessionMetaArray(result) ? { status: 'native', value: result } : { status: 'fallback' };
  }

  async sizeBytes(): Promise<NativeSessionStoreResult<number>> {
    const ready = await this.ensureOpened();
    if (!ready) return { status: 'fallback' };

    const result = await this.callNative('session_store.size_bytes');
    const size = readNumberField(result, 'size');
    return size === undefined ? { status: 'fallback' } : { status: 'native', value: size };
  }

  private async ensureOpened(): Promise<boolean> {
    if (this.opened) return true;
    if (this.disabled) return false;

    const selection = this.bridge.selection;
    if (!selection.enabled) {
      this.disabled = true;
      return false;
    }

    await this.callNative('session_store.open', {
      path: this.options.path,
      cache_size: this.options.cacheSize,
    });
    this.opened = true;
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

  private get bridge(): NativeSessionStoreRuntimeBridge {
    return this.options.bridge ?? DEFAULT_NATIVE_SESSION_STORE_BRIDGE;
  }
}

const DEFAULT_NATIVE_SESSION_STORE_BRIDGE = new NativeCoreBridge();

