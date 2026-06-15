/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type ToolResult,
  type ToolCallConfirmationDetails,
  Kind,
  ApprovalMode,
  ToolConfirmationOutcome,
  proxyAuthManager,
  tokenLimit,
} from 'otto-core';
import type * as acp from '@agentclientprotocol/sdk';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import { z } from 'zod';
import type { LoadedSettings } from '../config/settings.js';

/**
 * Build the `session/update` payload for `sessionUpdate: 'usage_update'`.
 *
 * `UsageUpdate` is marked UNSTABLE in the ACP SDK schema (see
 * `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts` —
 * `UsageUpdate`), but the wire shape is stable: `{ used, size, cost? }`.
 *
 *   - `used`  — total tokens currently in the chat's context window for the
 *               most recent turn. Pulled from the model's `usageMetadata`
 *               via {@link GeminiChat.getFinalUsageMetadata}.
 *   - `size`  — total context window of the *currently selected* model,
 *               resolved through {@link tokenLimit} (server-authoritative
 *               via `Config.getCloudModelInfo`).
 *
 * Returns `null` when neither token count nor a model is known yet — caller
 * should skip emitting in that case so the IDE keeps showing its previous
 * estimate instead of flickering to 0/0.
 */
export function buildUsageUpdate(
  usage: GenerateContentResponseUsageMetadata | undefined,
  config: Config,
): acp.SessionUpdate | null {
  // The Gemini SDK reports usage in slightly different fields depending on
  // backend (Gemini vs proxy-Claude). `totalTokenCount` is the canonical
  // "what's currently being billed for this turn"; fall back to the sum
  // when the proxy only reports the split.
  const used =
    usage?.totalTokenCount ??
    ((usage?.promptTokenCount ?? 0) + (usage?.candidatesTokenCount ?? 0));
  if (!used) return null;

  const model = config.getModel?.() ?? 'auto';
  const size = tokenLimit(model, config);
  if (!size) return null;

  return {
    sessionUpdate: 'usage_update',
    used,
    size,
  } as acp.SessionUpdate;
}

/** Type guard: does `obj` carry a `_meta` field (per ACP spec)? */
export function hasMeta(
  obj: unknown,
): obj is { _meta?: Record<string, unknown> } {
  return typeof obj === 'object' && obj !== null && '_meta' in obj;
}

/**
 * Zod schema for the response to {@link acp.Client.requestPermission}.
 * ACP clients reply with either `{outcome: 'cancelled'}` or
 * `{outcome: 'selected', optionId: '...'}`.
 */
export const RequestPermissionResponseSchema = z.object({
  outcome: z.discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('cancelled') }),
    z.object({
      outcome: z.literal('selected'),
      optionId: z.string(),
    }),
  ]),
});

/**
 * Map an internal {@link ToolResult} to the wire shape expected in
 * `session/update#tool_call` `content` fields.
 *
 * Returns `null` when the tool produced no user-visible output (e.g. a pure
 * background side-effect) — callers should then omit `content` entirely.
 */
export function toToolCallContent(
  toolResult: ToolResult,
): acp.ToolCallContent | null {
  if (toolResult.returnDisplay) {
    if (typeof toolResult.returnDisplay === 'string') {
      return {
        type: 'content',
        content: { type: 'text', text: toolResult.returnDisplay },
      };
    }
    if ('fileName' in toolResult.returnDisplay) {
      const display = toolResult.returnDisplay as {
        fileName: string;
        filePath?: string;
        originalContent?: string;
        newContent: string;
      };
      const oldText = display.originalContent ?? '';
      const newText = display.newContent ?? '';
      const kind = !oldText ? 'add' : newText === '' ? 'delete' : 'modify';
      return {
        type: 'diff',
        path: display.filePath ?? display.fileName,
        oldText,
        newText,
        _meta: { kind },
      };
    }
  }
  return null;
}

const basicPermissionOptions: acp.PermissionOption[] = [
  {
    optionId: ToolConfirmationOutcome.ProceedOnce,
    name: 'Allow',
    kind: 'allow_once',
  },
  {
    optionId: ToolConfirmationOutcome.Cancel,
    name: 'Reject',
    kind: 'reject_once',
  },
];

/**
 * Build the `PermissionOption[]` array sent to the IDE when a tool call
 * needs user approval. Mirrors gemini-cli's logic: the "always allow"
 * variants are produced for tool kinds that support them (edit/exec/mcp/
 * info) and suppressed for `ask_user` / plan-mode exits.
 *
 * DeepCode's `Config` does not currently expose `getDisableAlwaysAllow`, so
 * the flag is queried via duck-typing and defaults to `false`.
 */
export function toPermissionOptions(
  confirmation: ToolCallConfirmationDetails,
  config: Config,
  enablePermanentToolApproval = false,
): acp.PermissionOption[] {
  const cfg = config as unknown as { getDisableAlwaysAllow?: () => boolean };
  const disableAlwaysAllow = cfg.getDisableAlwaysAllow?.() ?? false;
  const options: acp.PermissionOption[] = [];

  if (!disableAlwaysAllow) {
    switch (confirmation.type) {
      case 'edit':
        options.push({
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Allow for this session',
          kind: 'allow_always',
        });
        if (enablePermanentToolApproval) {
          options.push({
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Allow for this file in all future sessions',
            kind: 'allow_always',
          });
        }
        break;
      case 'exec':
        options.push({
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Allow for this session',
          kind: 'allow_always',
        });
        if (enablePermanentToolApproval) {
          options.push({
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Allow this command for all future sessions',
            kind: 'allow_always',
          });
        }
        break;
      case 'mcp':
        options.push(
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysServer,
            name: 'Allow all server tools for this session',
            kind: 'allow_always',
          },
          {
            optionId: ToolConfirmationOutcome.ProceedAlwaysTool,
            name: 'Allow tool for this session',
            kind: 'allow_always',
          },
        );
        if (enablePermanentToolApproval) {
          options.push({
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Allow tool for all future sessions',
            kind: 'allow_always',
          });
        }
        break;
      case 'info':
        options.push({
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Allow for this session',
          kind: 'allow_always',
        });
        if (enablePermanentToolApproval) {
          options.push({
            optionId: ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Allow for all future sessions',
            kind: 'allow_always',
          });
        }
        break;
      default:
        // ask_user / exit_plan_mode / unknown: only basic options.
        break;
    }
  }
  options.push(...basicPermissionOptions);
  return options;
}

/**
 * Decide whether an ACP caller (the upstream agent) should be asked to
 * approve this tool call, or whether the otto ACP runtime can silently
 * proceed.
 *
 * Rationale: ACP is agent-to-agent. The TUI equivalent is YOLO mode, which
 * auto-runs routine edits/writes/shell commands but still hard-stops on
 * dangerous shell invocations, destructive file deletes, and explicit
 * `ask_user_question` calls. We mirror that split here:
 *
 *   - `question`            — always needs approval; only a real user can
 *                             meaningfully answer a multiple-choice question.
 *   - `exec` with `warning` — dangerous-command-detector matched; refuse
 *                             to run silently even under YOLO.
 *   - `delete`              — irreversible file removal.
 *   - everything else       — proceed automatically (ProceedOnce).
 *
 * Unknown confirmation shapes default to "needs approval" (safe fallback).
 */
export function confirmationRequiresCallerApproval(
  confirmation: ToolCallConfirmationDetails,
): boolean {
  switch (confirmation.type) {
    case 'question':
      return true;
    case 'exec':
      return Boolean((confirmation as { warning?: string }).warning);
    case 'delete':
      return true;
    case 'edit':
    case 'mcp':
    case 'info':
      return false;
    default:
      return true;
  }
}

/**
 * Map DeepCode's {@link Kind} to the ACP `ToolKind` wire type.
 *
 * Several kinds that have no exact ACP counterpart (`Agent`, `Plan`,
 * `Communicate`, `SwitchMode`) are folded into `'other'` / `'think'`.
 */
export function toAcpToolKind(kind: Kind): acp.ToolKind {
  switch (kind) {
    case Kind.Read:
    case Kind.Edit:
    case Kind.Execute:
    case Kind.Search:
    case Kind.Delete:
    case Kind.Move:
    case Kind.Think:
    case Kind.Fetch:
    case Kind.Other:
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return kind as unknown as acp.ToolKind;
    case Kind.Agent:
      return 'think' as acp.ToolKind;
    case Kind.Plan:
    case Kind.Communicate:
    case Kind.SwitchMode:
    default:
      return 'other' as acp.ToolKind;
  }
}

/**
 * Build the list of session modes announced to the IDE.
 *
 * DeepCode's {@link ApprovalMode} enum does not include a `PLAN` variant
 * (gemini-cli ships one behind a flag), so the `isPlanEnabled` parameter is
 * accepted for API compatibility but currently has no effect.
 */
export function buildAvailableModes(
  _isPlanEnabled: boolean = false,
): acp.SessionMode[] {
  return [
    {
      id: ApprovalMode.DEFAULT,
      name: 'Default',
      description: 'Prompts for approval',
    },
    {
      id: ApprovalMode.AUTO_EDIT,
      name: 'Auto Edit',
      description: 'Auto-approves edit tools',
    },
    {
      id: ApprovalMode.YOLO,
      name: 'YOLO',
      description: 'Auto-approves all tools',
    },
  ];
}

/**
 * Build the list of models surfaced to the IDE for session-model switching.
 *
 * Pulls the authoritative list from `Config.getCloudModels()` (populated by
 * the proxy's `/web-api/models` endpoint — same source the interactive CLI
 * uses for `/model`). Always prepends `auto` and guarantees the currently
 * selected model is present, even when it's not in the cloud catalogue.
 */
export function buildAvailableModels(
  config: Config,
  _settings: LoadedSettings,
): {
  availableModels: Array<{
    modelId: string;
    name: string;
    description?: string;
  }>;
  currentModelId: string;
} {
  const current = config.getModel?.() ?? 'auto';
  const preferred = config.getPreferredModel?.() ?? current;
  const cloudModels = config.getCloudModels?.() ?? [];
  const seen = new Set<string>();
  const models: Array<{
    modelId: string;
    name: string;
    description?: string;
  }> = [];

  // 1) `auto` is always first — it's the server-pick default.
  models.push({
    modelId: 'auto',
    name: 'Auto',
    description: 'Server-selected model',
  });
  seen.add('auto');

  // 2) Whatever the cloud says is available.
  for (const m of cloudModels) {
    if (!m?.name || seen.has(m.name)) continue;
    if (m.available === false) continue;
    seen.add(m.name);
    models.push({ modelId: m.name, name: m.displayName || m.name });
  }

  // 3) Make sure the currently-selected and preferred ids are visible even
  //    if they're not in the cloud list (user just switched to one via /model,
  //    cache empty on first run, etc.).
  for (const id of [preferred, current]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ modelId: id, name: id });
  }

  return { availableModels: models, currentModelId: current };
}

/**
 * Model ids we always advertise in the `configOptions[id="model"]` selector.
 *
 * DeepCode resolves the final model server-side, so the client-visible list
 * is short and curated rather than dynamically fetched. The `"auto"` entry
 * keeps the legacy server-decides behavior. Every id in this list is
 * accepted by `Config.setModel` without validation (the proxy will reject
 * at call time if the underlying account doesn't have access).
 */
/**
 * Fallback model ids when the server-provided list isn't available yet
 * (e.g. first ACP session before /web-api/models has been fetched, or
 * offline-ish scenarios). Only entries here that the proxy actually
 * accepts will work; kept intentionally minimal to avoid surfacing
 * decommissioned ids (we hit this exact bug with an outdated
 * `claude-sonnet-4-5`).
 */
const FALLBACK_MODEL_IDS: Array<{
  value: string;
  name: string;
  description?: string;
}> = [
  { value: 'auto', name: 'Auto', description: 'Server-selected model' },
];

/**
 * Snapshot the full `configOptions[]` array a client should see right now.
 *
 * The shape matches ACP's `SessionConfigOption`. We currently expose:
 *   - `model` (select): switches the LLM.
 *
 * The model list is pulled from `Config.getCloudModels()` — the authoritative
 * list that the proxy server provides via `/web-api/models`. When that cache
 * is empty (first run, no prior `/model` invocation, etc.) we fall back to
 * showing just `auto` + whatever model `Config.getModel()` currently reports,
 * so the IDE has at least one valid choice.
 *
 * When DeepCode ships more per-session knobs (thought level, turn timeout,
 * etc.) just add them here and to `Session.applyConfigOption`.
 */
export function buildConfigOptionsSnapshot(
  config: Config,
  overrides: ReadonlyMap<string, string | boolean>,
): acp.SessionConfigOption[] {
  const currentModel =
    (overrides.get('model') as string | undefined) ??
    config.getModel?.() ??
    'auto';

  const cloudModels = config.getCloudModels?.() ?? [];
  const seen = new Set<string>();
  const options: Array<{ value: string; name: string; description?: string }> = [];

  for (const entry of FALLBACK_MODEL_IDS) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    options.push(entry);
  }
  for (const m of cloudModels) {
    if (!m?.name || seen.has(m.name)) continue;
    if (m.available === false) continue;
    seen.add(m.name);
    options.push({
      value: m.name,
      name: m.displayName || m.name,
    });
  }
  // Ensure the currently-selected model is in the list even if it's not
  // marked available (server just rolled it back, user got it via /model,
  // etc.). Without this, ACP clients may refuse the snapshot.
  if (currentModel && !seen.has(currentModel)) {
    seen.add(currentModel);
    options.push({ value: currentModel, name: currentModel });
  }

  const modelOption: acp.SessionConfigOption = {
    id: 'model',
    type: 'select',
    name: 'Model',
    description: 'LLM used for this session',
    category: 'model',
    currentValue: currentModel,
    options: options.map((o) => ({
      value: o.value,
      name: o.name,
      ...(o.description ? { description: o.description } : {}),
    })),
  };
  return [modelOption];
}

interface WebApiModelInfo {
  name: string;
  displayName: string;
  creditsPerRequest?: number;
  available?: boolean;
  maxToken?: number;
  highVolumeThreshold?: number;
  highVolumeCredits?: number;
}

/**
 * Fetch the authoritative list of models the proxy will accept and seed
 * `Config.setCloudModels` with it.
 *
 * The interactive CLI does this lazily, on the first `/model` invocation.
 * ACP clients never fire `/model` (they call `session/set_config_option`
 * with whatever id the IDE's picker selected), so without this preload the
 * ACP agent would advertise an empty/fallback model list and accept any
 * string — then the server would reject it with a 500 "不支持的模型".
 *
 * Best-effort: network/auth failures here are logged but never fatal.
 * Without the cache, the snapshot falls back to `auto` + the current model.
 */
export async function refreshCloudModelsForAcp(config: Config): Promise<void> {
  if (!config.setCloudModels) return;
  try {
    const headers = await proxyAuthManager.getUserHeaders();
    const baseUrl = proxyAuthManager.getProxyServerUrl();
    if (!baseUrl) return;

    const url = `${baseUrl.replace(/\/+$/, '')}/web-api/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'DeepCode ACP',
        ...headers,
      },
    });
    if (!res.ok) {
      process.stderr.write(
        `[acp] /web-api/models HTTP ${res.status}, skipping model-list preload\n`,
      );
      return;
    }
    const body = (await res.json()) as {
      success?: boolean;
      data?: WebApiModelInfo[];
    };
    if (!body?.success || !Array.isArray(body.data)) {
      process.stderr.write(
        '[acp] /web-api/models returned no data, skipping model-list preload\n',
      );
      return;
    }
    const models = body.data
      .filter((m): m is WebApiModelInfo => !!m && typeof m.name === 'string')
      .map((m) => ({
        name: m.name,
        displayName: m.displayName || m.name,
        creditsPerRequest: m.creditsPerRequest ?? 0,
        available: m.available !== false,
        maxToken: m.maxToken ?? 0,
        highVolumeThreshold: m.highVolumeThreshold ?? 0,
        highVolumeCredits: m.highVolumeCredits ?? 0,
      }));
    config.setCloudModels(models);
    process.stderr.write(
      `[acp] loaded ${models.length} models from ${url}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[acp] model-list preload failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
