/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { GenerateContentResponse } from '@google/genai';
import { MESSAGE_ROLES } from '../config/messageRoles.js';
import { CustomModelConfig, resolveThinkingConfig, effortToGeminiLevel, effortToGeminiBudget } from '../types/customModel.js';
import { sanitiseGeminiTools } from './customModelGeminiSchema.js';

// ============================================================================
// Gemini native (GenAI v1beta) — POST /v1beta/models/{id}:streamGenerateContent
// ----------------------------------------------------------------------------
// Mirrors what OttoServerAdapter sends for Gemini through its proxy: the
// request body is a real Google GenAI payload (not OpenAI-shimmed), so we
// keep `thinkingConfig`, `thoughts`, `parts.functionCall`, and other native
// features instead of round-tripping through OpenAI's reduced schema.
//
// Probe-confirmed (2026-05-26) on EasyRouter:
//   • /v1beta/models/{id}:streamGenerateContent?key=…&alt=sse  → 200 OK
//   • thinkingConfig: { thinkingBudget: -1, includeThoughts: true } actually
//     emits parts with `thought: true` and reasoning text.
// See scripts/probe-gemini-thinking.mjs for the verification harness.
// ============================================================================

/**
 * Apply user's resolved {@link ThinkingConfig} to a Gemini GenAI request body.
 * Branches on Gemini family the same way OttoServerAdapter does:
 *   - Gemini 3 / 3.5  →  thinkingConfig.thinkingLevel ('minimal'|'low'|'medium'|'high')
 *   - Gemini 2.5 (default) →  thinkingConfig.thinkingBudget (number; -1=dynamic, 0=disable)
 * Always sets `includeThoughts: true` when thinking is on so the model emits
 * `parts[].thought = true` chunks the UI renders as the thinking block.
 */
function applyGeminiNativeThinking(
  generationConfig: Record<string, unknown>,
  modelId: string,
  thinking: ReturnType<typeof resolveThinkingConfig>,
): void {
  const lower = modelId.toLowerCase();
  const isGemini3 = lower.includes('gemini-3') || lower.includes('gemini-3.5');
  if (thinking.mode === 'off') {
    generationConfig.thinkingConfig = isGemini3
      ? { thinkingLevel: 'minimal' }
      : { thinkingBudget: 0 };
    return;
  }
  if (isGemini3) {
    const level = effortToGeminiLevel(thinking.effort) || 'medium';
    generationConfig.thinkingConfig = { thinkingLevel: level, includeThoughts: true };
  } else {
    const budget =
      thinking.budgetTokens !== undefined
        ? thinking.budgetTokens
        : effortToGeminiBudget(thinking.effort) ?? -1; // -1 = dynamic thinking (Gemini 2.5 default)
    generationConfig.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
  }
}

/**
 * Build the GenAI native request body. Forwards `request.contents` /
 * `request.config.tools` / `request.config.systemInstruction` etc. directly —
 * the server-side proxy has been doing this same passthrough already.
 */
export function buildGeminiNativeRequestBody(
  modelConfig: CustomModelConfig,
  request: any,
  maxOutputTokens: number,
): Record<string, unknown> {
  const reqConfig = request?.config || {};
  const generationConfig: Record<string, unknown> = {
    ...(reqConfig.generationConfig || {}),
  };
  // Pull selected top-level GenAI config knobs into generationConfig
  // (the Google SDK lets users specify either at top-level config.* or under
  // generationConfig.*; we normalise into generationConfig for the wire body).
  for (const k of ['temperature', 'topP', 'topK', 'maxOutputTokens', 'stopSequences', 'candidateCount', 'responseMimeType', 'responseSchema'] as const) {
    if (reqConfig[k] !== undefined && generationConfig[k] === undefined) {
      generationConfig[k] = reqConfig[k];
    }
  }

  // 🟢 maxOutputTokens 兜底：request 没指定 → 用 modelConfig.maxOutputTokens
  // （EasyClaw 元数据填的）→ 用 32K 默认。统一走 resolveOutputTokens。
  if (generationConfig['maxOutputTokens'] === undefined) {
    generationConfig['maxOutputTokens'] = maxOutputTokens;
  }

  const thinkingConfig = resolveThinkingConfig(modelConfig);
  applyGeminiNativeThinking(generationConfig, modelConfig.modelId, thinkingConfig);

  /**
   * Sanitise `contents[].parts[]` for the GenAI v1beta endpoint.
   *
   * The chat history we accumulate contains UI-only / cross-protocol shapes
   * that Gemini's strict schema rejects with HTTP 400:
   *   * .parts[i].data: required oneof field 'data' must have one initialized field
   *   * Function call is missing a thought_signature in functionCall parts
   *
   * Specifically:
   *   - { reasoning } (our adapter's projection of Gemini `thought:true` parts) →
   *     converted back to `{ thought:true, text, thoughtSignature? }` so any
   *     thoughtSignature attached to the reasoning chunk survives the round
   *     trip. Gemini 3.x with thinking REQUIRES the matching thoughtSignature
   *     to be sent back, otherwise the next functionCall is rejected.
   *   - { thought:true, text, thoughtSignature? } (raw) — kept as-is.
   *   - functionCall / functionResponse — pass through after non-empty check;
   *     thoughtSignature is preserved.
   *   - text / inlineData / fileData — pass through canonically.
   * Empty / unknown parts are dropped (oneof validator fails on `{}`).
   *
   * 🆕 Cross-model migration → Gemini 3.x downgrade
   *   `thoughtSignature` is an opaque server-signed token: the client cannot
   *   forge or back-fill it. When a user accumulates history with Opus /
   *   GPT-4 / Gemini 2.5 and then switches to Gemini 3.x, the historical
   *   functionCall parts have NO signature, and Gemini 3.x will reject the
   *   request with HTTP 400 "Function call is missing a thought_signature".
   *
   *   Strategy: pre-scan the history once, identify every "naked" functionCall
   *   (one without a thoughtSignature) when targeting Gemini 3.x, and rewrite
   *   BOTH that part AND its paired functionResponse into plain text summary
   *   parts. The semantic information (which tool, what args, what result)
   *   survives as text — Gemini 3.x reads it as "previous tool activity
   *   described in prose", and the protocol constraint disappears because no
   *   `functionCall` part remains in the wire body.
   *
   *   Pairing key: `functionCall.id` if present, else `name:<name>`.
   *   Native Gemini 3.x → 3.x is unaffected: signed parts still round-trip.
   *   Gemini 2.5 / non-3.x targets are unaffected: detection gated on modelId.
   */
  const lowerModelId = (modelConfig.modelId || '').toLowerCase();
  const isGemini3Target = lowerModelId.includes('gemini-3');

  // Pre-scan: collect pairing keys of naked functionCall parts so we can
  // rewrite both the call AND its corresponding response as text.
  const nakedCallKeys: Set<string> = new Set();
  if (isGemini3Target && Array.isArray(request.contents)) {
    for (const c of request.contents) {
      if (!c || typeof c !== 'object') continue;
      const parts = Array.isArray(c.parts) ? c.parts : [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        if (
          p.functionCall &&
          typeof p.functionCall === 'object' &&
          typeof p.functionCall.name === 'string' &&
          p.functionCall.name.length > 0 &&
          typeof p.thoughtSignature !== 'string'
        ) {
          const key =
            typeof p.functionCall.id === 'string' && p.functionCall.id.length > 0
              ? p.functionCall.id
              : `name:${p.functionCall.name}`;
          nakedCallKeys.add(key);
        }
      }
    }
  }

  // Compact JSON helper for tool-summary text — keeps the line readable in
  // the model's context. Defensive against non-serialisable args.
  const safeStringify = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    try {
      const s = JSON.stringify(v);
      // Trim absurdly long blobs so a single huge tool result doesn't blow
      // up the migrated summary line.
      return s.length > 2000 ? s.slice(0, 2000) + '…(truncated)' : s;
    } catch {
      return String(v);
    }
  };

  const sanitiseContentsForGemini = (raw: any[] | undefined): any[] => {
    if (!Array.isArray(raw)) return [];
    const out: any[] = [];
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue;
      const role = c.role;
      const parts = Array.isArray(c.parts) ? c.parts : [];
      const cleanParts: any[] = [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        // 1) UI-only `reasoning` projection → fold back to a thought part so
        //    the attached thoughtSignature (if any) is preserved.
        if (typeof p.reasoning === 'string') {
          if (p.reasoning.length === 0) continue;
          const part: any = { thought: true, text: p.reasoning };
          if (typeof p.thoughtSignature === 'string') part.thoughtSignature = p.thoughtSignature;
          cleanParts.push(part);
          continue;
        }
        // 2) Raw Gemini `thought:true` part — pass through with signature.
        if (p.thought === true) {
          if (typeof p.text !== 'string' || p.text.length === 0) continue;
          const part: any = { thought: true, text: p.text };
          if (typeof p.thoughtSignature === 'string') part.thoughtSignature = p.thoughtSignature;
          cleanParts.push(part);
          continue;
        }
        // 3) Canonical GenAI shapes — pass through, but verify the inner
        // shape is non-empty. The error
        //   * parts[i].data: required oneof field 'data' must have one initialized field
        // is also raised for shapes like `{ inlineData: {} }` or
        // `{ functionResponse: { name:'…' } }` (missing `response`).
        if (typeof p.text === 'string') {
          // GenAI rejects '' for some models; keep only meaningful text.
          if (p.text.length > 0) cleanParts.push({ text: p.text });
          continue;
        }
        if (p.inlineData && typeof p.inlineData === 'object') {
          const inline = p.inlineData as Record<string, unknown>;
          if (typeof inline.mimeType === 'string' && typeof inline.data === 'string' && inline.data.length > 0) {
            cleanParts.push({ inlineData: { mimeType: inline.mimeType, data: inline.data } });
          }
          continue;
        }
        if (p.functionCall && typeof p.functionCall === 'object') {
          const fc = p.functionCall as Record<string, unknown>;
          if (typeof fc.name === 'string' && fc.name.length > 0) {
            // 🆕 Naked functionCall on Gemini 3.x → downgrade to text summary.
            // We cannot synthesise a thoughtSignature (server-signed opaque
            // token), so preserve the semantics as prose instead. The paired
            // functionResponse is downgraded in the same pass below.
            if (isGemini3Target && typeof p.thoughtSignature !== 'string') {
              const argsStr = safeStringify(fc.args);
              cleanParts.push({
                text: `[Previous tool call] ${fc.name}(${argsStr})`,
              });
              continue;
            }
            const part: any = {
              functionCall: {
                name: fc.name,
                args: (fc.args && typeof fc.args === 'object') ? fc.args : {},
                ...(typeof fc.id === 'string' ? { id: fc.id } : {}),
              },
            };
            // Preserve thoughtSignature on the part (Gemini 3.x with thinking
            // requires this to round-trip; missing it ⇒ HTTP 400).
            if (typeof p.thoughtSignature === 'string') {
              part.thoughtSignature = p.thoughtSignature;
            }
            cleanParts.push(part);
          }
          continue;
        }
        if (p.functionResponse && typeof p.functionResponse === 'object') {
          const fr = p.functionResponse as Record<string, unknown>;
          // GenAI requires both `name` and `response` to be present and non-empty.
          // If the response payload is missing/empty we synthesise an empty
          // object so the part stays valid; dropping it would unbalance the
          // tool-call/response pairing and cause subsequent 400s.
          if (typeof fr.name === 'string' && fr.name.length > 0) {
            // 🆕 If this response pairs with a naked (downgraded) functionCall,
            // downgrade it as text too — keeping a `functionResponse` part
            // without its matching `functionCall` would produce a different
            // 400 ("functionResponse without preceding functionCall").
            if (isGemini3Target) {
              const key =
                typeof fr.id === 'string' && fr.id.length > 0
                  ? fr.id
                  : `name:${fr.name}`;
              if (nakedCallKeys.has(key)) {
                const resultStr = safeStringify(fr.response);
                cleanParts.push({
                  text: `[Previous tool result] ${fr.name} → ${resultStr}`,
                });
                continue;
              }
            }
            const responseValue =
              fr.response && typeof fr.response === 'object'
                ? fr.response
                : { result: typeof fr.response === 'string' ? fr.response : '' };
            cleanParts.push({
              functionResponse: {
                name: fr.name,
                response: responseValue,
                ...(typeof fr.id === 'string' ? { id: fr.id } : {}),
              },
            });
          }
          continue;
        }
        if (p.fileData && typeof p.fileData === 'object') {
          const fd = p.fileData as Record<string, unknown>;
          if (typeof fd.fileUri === 'string' && fd.fileUri.length > 0) {
            cleanParts.push({
              fileData: {
                fileUri: fd.fileUri,
                ...(typeof fd.mimeType === 'string' ? { mimeType: fd.mimeType } : {}),
              },
            });
          }
          continue;
        }
        // Unknown shapes silently dropped — better than a 400 from Gemini.
      }
      // A Content with zero valid parts also fails validation; skip it.
      if (cleanParts.length === 0) continue;
      out.push(role ? { role, parts: cleanParts } : { parts: cleanParts });
    }
    return out;
  };

  const body: Record<string, unknown> = {
    contents: sanitiseContentsForGemini(request.contents),
    generationConfig,
  };
  /**
   * Normalise `systemInstruction` to the GenAI wire shape `{ parts: [{ text }] }`.
   *
   * Callers historically passed it as either:
   *   - a plain string (legacy convenience)
   *   - `{ parts: [{ text }] }` (canonical GenAI)
   *   - `{ text: '...' }` (intermediate form some adapters used)
   * EasyRouter / Google's actual `/v1beta` endpoint only accepts the canonical
   * form — passing a string yields HTTP 500 "json: cannot unmarshal string
   * into Go struct field .systemInstruction of type OttoChatContent".
   */
  const normaliseSystemInstruction = (raw: unknown): unknown => {
    if (raw == null) return undefined;
    if (typeof raw === 'string') {
      return { parts: [{ text: raw }] };
    }
    if (typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      // already canonical
      if (Array.isArray(obj.parts)) return obj;
      // {text:'…'} short form
      if (typeof obj.text === 'string') return { parts: [{ text: obj.text }] };
    }
    // Anything weirder — let it through verbatim; the upstream error message
    // will still be informative if the structure is unrecognised.
    return raw;
  };

  if (reqConfig.systemInstruction) {
    const normalised = normaliseSystemInstruction(reqConfig.systemInstruction);
    if (normalised !== undefined) body.systemInstruction = normalised;
  }
  if (reqConfig.tools) {
    // Strip JSON-Schema-only keys (e.g. `$schema` from MCP tools) and
    // normalise types/combinators down to Gemini's accepted Schema subset.
    // Without this, MCP-supplied tool schemas trigger HTTP 400 from the
    // upstream — the OttoServerAdapter path is shielded by the proxy doing
    // the same cleaning, but here we're talking to EasyRouter / Google
    // directly. See sanitiseGeminiToolSchema for the full rationale.
    body.tools = sanitiseGeminiTools(reqConfig.tools);
  }
  if (reqConfig.toolConfig) body.toolConfig = reqConfig.toolConfig;
  if (reqConfig.safetySettings) body.safetySettings = reqConfig.safetySettings;
  return body;
}

/**
 * Build the EasyRouter / GenAI endpoint URL. Uses Google's documented
 * `?key=...` form (works on both google.googleapis.com and the EasyRouter
 * gateway, no Authorization header required).
 */
export function buildGeminiNativeUrl(
  modelId: string,
  baseUrlValue: string,
  apiKeyValue: string,
  method: 'streamGenerateContent' | 'generateContent',
): string {
  const baseUrl = baseUrlValue.replace(/\/+$/, '');
  const apiKey = apiKeyValue;
  // Normalise base: callers configure `https://llm-endpoint.net/v1` from
  // EasyRouter, but the GenAI mount is /v1beta. If the configured base is
  // already a /v1beta-style endpoint, leave it alone.
  const root = baseUrl.endsWith('/v1beta')
    ? baseUrl
    : baseUrl.replace(/\/v1$/, '') + '/v1beta';
  const sep = method === 'streamGenerateContent' ? '?alt=sse&key=' : '?key=';
  return `${root}/models/${encodeURIComponent(modelId)}:${method}${sep}${encodeURIComponent(apiKey)}`;
}

/**
 * Normalise Gemini's usageMetadata into the cross-provider shape downstream
 * consumers expect.
 *
 * Why this exists:
 *   geminiChat.ts:240 (the single place that emits TokenUsageEvent for the
 *   "Token Usage" footer) reads `usageMetadata.cacheReadInputTokens` —
 *   the cross-provider canonical name set by anthropic / openai-chat /
 *   openai-responses paths in this same file. Gemini, however, uses
 *   `cachedContentTokenCount` (camelCase, with `Count` suffix). Forwarding
 *   `data.usageMetadata` verbatim therefore caused the UI to permanently
 *   show "No cache information available" for any custom Gemini model,
 *   even when the upstream had handed back e.g. `cachedContentTokenCount: 3059`.
 *
 * Verified end-to-end via scripts/probe-cache-fields.mjs (round 2 hits
 * always populate cachedContentTokenCount on EasyRouter's
 * /v1beta/...:generateContent, both unary and SSE).
 *
 * Strategy: keep all original Gemini fields (some downstream code, e.g.
 * SessionManager, still reads `cachedContentTokenCount` directly), and
 * additionally project `cacheReadInputTokens` as an alias. We deliberately
 * do NOT synthesise `cacheCreationInputTokens` — Gemini's implicit cache has
 * no "creation" phase visible to clients (the tokens are billed once at
 * input rate; the cache is server-managed). Pretending otherwise would
 * double-count in cost calculators.
 */
export function normaliseGeminiUsageMetadata(usage: any): any {
  if (!usage || typeof usage !== 'object') return usage;
  const cached = usage.cachedContentTokenCount || 0;
  // Already normalised (defensive — never expected from Google's API today).
  if (typeof usage.cacheReadInputTokens === 'number') return usage;
  return {
    ...usage,
    // Alias only when the upstream actually reported a hit; absent field
    // (round 1, miss) → leave undefined so existing `|| 0` fallbacks
    // downstream behave identically.
    ...(cached > 0 && { cacheReadInputTokens: cached }),
  };
}

/**
 * Map a single GenAI streaming JSON chunk to one or more
 * GenerateContentResponse-shaped objects ready to yield. Specifically, splits
 * `parts[]` into:
 *   • `{ thought: true, text }` → `{ reasoning: text }` (UI thinking block)
 *   • `{ text }`                → `{ text }`            (regular output)
 *   • `{ functionCall }`        → `{ functionCall }`
 * so downstream chat consumers see the same shape they expect from any other
 * provider.
 */
export function* mapGeminiChunkToResponses(
  chunk: any,
  attachFunctionCallsGetter: (obj: any) => void,
): Generator<GenerateContentResponse> {
  const cand = chunk?.candidates?.[0];
  const parts = cand?.content?.parts;
  if (Array.isArray(parts) && parts.length > 0) {
    const mappedParts: any[] = [];
    for (const p of parts) {
      // Gemini 3.x with thinking emits a `thoughtSignature` on functionCall
      // parts. We must propagate it back on the next request, otherwise
      // Gemini rejects with HTTP 400 "Function call is missing a thought_signature".
      // Carry the field as-is — opaque to us, validated by Gemini.
      if (p?.thought === true && typeof p.text === 'string') {
        const out: any = { reasoning: p.text };
        if (typeof p.thoughtSignature === 'string') out.thoughtSignature = p.thoughtSignature;
        mappedParts.push(out);
      } else if (typeof p?.text === 'string') {
        const out: any = { text: p.text };
        if (typeof p.thoughtSignature === 'string') out.thoughtSignature = p.thoughtSignature;
        mappedParts.push(out);
      } else if (p?.functionCall) {
        const out: any = {
          functionCall: {
            name: p.functionCall.name?.trim() || p.functionCall.name,
            args: p.functionCall.args || {},
            id: p.functionCall.id,
          },
        };
        if (typeof p.thoughtSignature === 'string') out.thoughtSignature = p.thoughtSignature;
        mappedParts.push(out);
      } else if (p?.inlineData) {
        // Pass through inline image/audio data unchanged.
        mappedParts.push({ inlineData: p.inlineData });
      }
    }
    if (mappedParts.length > 0) {
      const content = { role: MESSAGE_ROLES.MODEL, parts: mappedParts };
      const resp = {
        candidates: [
          {
            content,
            ...(cand.finishReason ? { finishReason: cand.finishReason } : {}),
            index: 0,
          },
        ],
      };
      attachFunctionCallsGetter(resp);
      attachFunctionCallsGetter(content);
      yield resp as any as GenerateContentResponse;
    }
  }
  // Usage metadata may arrive on any chunk (often the last one) — forward it,
  // normalising Gemini's cache token field name so the UI footer can pick
  // up cache hits the same way it does for anthropic / openai-* providers.
  if (chunk?.usageMetadata) {
    yield {
      candidates: [],
      usageMetadata: normaliseGeminiUsageMetadata(chunk.usageMetadata),
    } as any;
  }
}

/**
 * Drop the most recent Gemini native request body to
 * `~/.otto/last-requests/{ts}_gemini-{kind}_{modelId}.json` so when EasyRouter
 * / Google returns a schema-validation HTTP 400 we can inspect the *exact*
 * contents we sent at byte level. Cheap (≤20KB usually), fire-and-forget,
 * never blocks the request.
 *
 * Mirrors OttoServerAdapter.dumpOutboundRequest():
 *   - Same dir: `~/.otto/last-requests/`
 *   - Same ring buffer: keep the latest N entries
 *
 * Safety:
 *   - Disabled by default because the body contains full conversation text.
 *     It is enabled only for an explicit `FILE_DEBUG=1` diagnostic run.
 *   - Still skipped under `vitest` / NODE_ENV=test so tests never pollute the ring.
 *   - Atomic via `.tmp` + rename so an in-flight crash never leaves
 *     half-written / mixed-with-old-content bytes.
 */
const GEMINI_DUMP_DIR_SEGMENTS = ['.otto-user', 'last-requests'] as const;
const GEMINI_DUMP_RING_SIZE = 5;

export function shouldDumpGeminiRequest(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.FILE_DEBUG === '1' && !env.VITEST && env.NODE_ENV !== 'test';
}

/**
 * Sanitise a model id for use as a filesystem name segment.
 *
 * Strategy:
 *   - Lowercase
 *   - Replace any non `[a-z0-9._-]` character with `-`
 *   - Collapse repeats and trim leading/trailing dashes
 *   - Cap length to keep total path short on Windows (MAX_PATH = 260)
 *   - Fall back to `unknown-model` if the result is empty
 */
function sanitiseModelIdForFilename(raw: string | undefined): string {
  const id = (raw ?? '').toLowerCase().trim();
  const cleaned = id
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return cleaned || 'unknown-model';
}

export function dumpGeminiRequest(kind: 'unary' | 'stream', modelId: string, body: unknown): void {
  if (!shouldDumpGeminiRequest()) return;
  void (async () => {
    try {
      const os = await import('os');
      const path = await import('path');
      const fs = await import('fs');

      const home = os.homedir();
      const dumpDir = path.join(home, ...GEMINI_DUMP_DIR_SEGMENTS);
      await fs.promises.mkdir(dumpDir, { recursive: true });

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const safeModel = sanitiseModelIdForFilename(modelId);
      const ringFile = path.join(
        dumpDir,
        `${ts}_gemini-${kind}_${safeModel}.json`,
      );

      const payload = JSON.stringify(
        { kind, modelId, ts: new Date().toISOString(), body },
        null,
        2,
      );

      // Atomic write to ring entry.
      const tmp = ringFile + '.tmp';
      await fs.promises.writeFile(tmp, payload, 'utf8');
      await fs.promises.rename(tmp, ringFile);

      // Trim ring to the last GEMINI_DUMP_RING_SIZE Gemini entries
      // (OttoServerAdapter writes its own kinds in the same dir; we only
      // touch our own files identified by the `_gemini-` infix).
      try {
        const entries = await fs.promises.readdir(dumpDir);
        const stale = entries
          .filter((f) => /_gemini-(stream|unary)_/.test(f) && f.endsWith('.json'))
          .sort()
          .reverse() // newest first
          .slice(GEMINI_DUMP_RING_SIZE);
        await Promise.all(
          stale.map((f) => fs.promises.unlink(path.join(dumpDir, f)).catch(() => undefined)),
        );
      } catch {
        // ring trim is best-effort
      }
    } catch {
      // Diagnostic dump must never break the call.
    }
  })();
}
