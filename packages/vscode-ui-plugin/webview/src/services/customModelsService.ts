/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom Models Service (webview)
 * --------------------------------------------------------------------------
 * Thin RPC layer over the extension host's custom-model storage. Mirrors the
 * webViewModelService pattern: every request gets a generated `requestId`,
 * we resolve the matching response from the extension via globalMessageService.
 *
 * Why we do EasyRouter / EasyClaw fetches in the extension:
 *   The webview runs in a sandboxed iframe and VSCode's CSP rejects most
 *   outbound `fetch(...)` calls — that's also why the "model_response" /
 *   "get_available_models" path goes through the host. The extension host is
 *   plain Node, no CSP, so we forward both EasyRouter (`/v1/models`) and
 *   EasyClaw (`/api/v1/public-model-list`) calls there as well, keeping the
 *   API key inside ipcMessage payloads only.
 */

import type {
  CustomModelConfig,
  EasyClawModelMetadata,
  EasyRouterModelEntry,
} from '../types/customModel';
import { getGlobalMessageService } from './globalMessageService';

interface CustomModelsResponsePayload {
  requestId: string;
  success: boolean;
  models?: CustomModelConfig[];
  error?: string;
}

interface FetchEasyRouterResponsePayload {
  requestId: string;
  success: boolean;
  models?: EasyRouterModelEntry[];
  error?: string;
  status?: number;
}

interface FetchEasyClawResponsePayload {
  requestId: string;
  success: boolean;
  entries?: Array<[string, EasyClawModelMetadata]>;
  error?: string;
}

/**
 * Singleton webview service for custom-model RPCs.
 * Holds a single message-listener registration to multiplex matching responses
 * back to the originating `Promise`.
 */
class CustomModelsService {
  private static instance: CustomModelsService;
  private pending = new Map<string, (payload: any) => void>();
  private initialized = false;
  private changeListeners = new Set<(models: CustomModelConfig[]) => void>();

  private constructor() {
    this.initListeners();
  }

  static getInstance(): CustomModelsService {
    if (!CustomModelsService.instance) {
      CustomModelsService.instance = new CustomModelsService();
    }
    return CustomModelsService.instance;
  }

  private initListeners() {
    if (this.initialized) return;
    this.initialized = true;
    const ms = getGlobalMessageService();

    ms.onExtensionMessage('custom_models_response', (payload: CustomModelsResponsePayload) => {
      const cb = this.pending.get(payload.requestId);
      if (cb) {
        this.pending.delete(payload.requestId);
        cb(payload);
      }
    });

    ms.onExtensionMessage('fetch_easy_router_models_response', (payload: FetchEasyRouterResponsePayload) => {
      const cb = this.pending.get(payload.requestId);
      if (cb) {
        this.pending.delete(payload.requestId);
        cb(payload);
      }
    });

    ms.onExtensionMessage('fetch_easy_claw_metadata_response', (payload: FetchEasyClawResponsePayload) => {
      const cb = this.pending.get(payload.requestId);
      if (cb) {
        this.pending.delete(payload.requestId);
        cb(payload);
      }
    });

    // Broadcasts (no requestId): forward to anyone subscribed via onModelsChanged().
    ms.onExtensionMessage(
      'custom_models_changed',
      (payload: { models: CustomModelConfig[] }) => {
        for (const fn of this.changeListeners) {
          try {
            fn(payload.models);
          } catch (e) {
            console.error('[CustomModels] change listener error', e);
          }
        }
      },
    );
  }

  /**
   * Register a callback that fires whenever the extension persists a change
   * to ~/.deepv/custom-models.json. Returns an unsubscribe function.
   */
  onModelsChanged(handler: (models: CustomModelConfig[]) => void): () => void {
    this.changeListeners.add(handler);
    return () => {
      this.changeListeners.delete(handler);
    };
  }

  /** Get the list of currently configured custom models. */
  async listCustomModels(): Promise<CustomModelConfig[]> {
    return new Promise<CustomModelConfig[]>((resolve, reject) => {
      const requestId = this.genId();
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('list_custom_models timeout'));
      }, 8000);
      this.pending.set(requestId, (payload: CustomModelsResponsePayload) => {
        clearTimeout(timeout);
        if (payload.success) resolve(payload.models ?? []);
        else reject(new Error(payload.error || 'Failed to list custom models'));
      });
      getGlobalMessageService().send({
        type: 'list_custom_models',
        payload: { requestId },
      });
    });
  }

  /**
   * Persist one or more custom-model configs. The extension dedupes by
   * `displayName` (= identity), broadcasts the new list, and hot-reloads
   * Config in every running session.
   */
  async addCustomModels(models: CustomModelConfig[]): Promise<CustomModelConfig[]> {
    return new Promise<CustomModelConfig[]>((resolve, reject) => {
      const requestId = this.genId();
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('add_custom_models timeout'));
      }, 8000);
      this.pending.set(requestId, (payload: CustomModelsResponsePayload) => {
        clearTimeout(timeout);
        if (payload.success) resolve(payload.models ?? []);
        else reject(new Error(payload.error || 'Failed to save custom models'));
      });
      getGlobalMessageService().send({
        type: 'add_custom_models',
        payload: { requestId, models },
      });
    });
  }

  /** Delete a single custom model by `custom:{displayName}` id. */
  async deleteCustomModel(modelId: string): Promise<CustomModelConfig[]> {
    return new Promise<CustomModelConfig[]>((resolve, reject) => {
      const requestId = this.genId();
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('delete_custom_model timeout'));
      }, 8000);
      this.pending.set(requestId, (payload: CustomModelsResponsePayload) => {
        clearTimeout(timeout);
        if (payload.success) resolve(payload.models ?? []);
        else reject(new Error(payload.error || 'Failed to delete custom model'));
      });
      getGlobalMessageService().send({
        type: 'delete_custom_model',
        payload: { requestId, modelId },
      });
    });
  }

  /**
   * Pull the live EasyRouter model catalogue using the user-supplied API key.
   * Done via extension host to avoid CSP issues + keep the key off the wire
   * outside our own IPC channel.
   */
  async fetchEasyRouterModels(apiKey: string): Promise<EasyRouterModelEntry[]> {
    return new Promise<EasyRouterModelEntry[]>((resolve, reject) => {
      const requestId = this.genId();
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('fetch_easy_router_models timeout'));
      }, 20000);
      this.pending.set(requestId, (payload: FetchEasyRouterResponsePayload) => {
        clearTimeout(timeout);
        if (payload.success) resolve(payload.models ?? []);
        else {
          const err = new Error(payload.error || 'Failed to fetch EasyRouter models');
          (err as any).status = payload.status;
          reject(err);
        }
      });
      getGlobalMessageService().send({
        type: 'fetch_easy_router_models',
        payload: { requestId, apiKey },
      });
    });
  }

  /**
   * Public EasyClaw model metadata (max context length etc.). Best-effort —
   * unreachable EasyClaw must NOT block adding models, so we always resolve
   * to an empty Map on failure.
   */
  async fetchEasyClawMetadata(): Promise<Map<string, EasyClawModelMetadata>> {
    return new Promise<Map<string, EasyClawModelMetadata>>((resolve) => {
      const requestId = this.genId();
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(new Map()); // never reject — metadata is optional
      }, 12000);
      this.pending.set(requestId, (payload: FetchEasyClawResponsePayload) => {
        clearTimeout(timeout);
        if (payload.success && payload.entries) {
          resolve(new Map(payload.entries));
        } else {
          resolve(new Map());
        }
      });
      getGlobalMessageService().send({
        type: 'fetch_easy_claw_metadata',
        payload: { requestId },
      });
    });
  }

  private genId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
}

export const customModelsService = CustomModelsService.getInstance();
