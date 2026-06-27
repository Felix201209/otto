/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType as _AuthType,
  type Config,
  type OttoChat,
  type ToolResult,
  convertToFunctionResponse,
  logToolCall,
  isNodeError,
  isWithinRoot,
  getErrorMessage,
  getErrorStatus,
  MESSAGE_ROLES,
  SceneType,
  REFERENCE_CONTENT_START,
  REFERENCE_CONTENT_END,
  ToolConfirmationOutcome,
  coreEvents,
  CoreEvent,
  SessionManager as CoreSessionManager,
} from 'otto-core';
import * as acp from '@agentclientprotocol/sdk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type Content,
  type FunctionCall,
  type Part,
  type PartListUnion,
 GenerateContentResponse } from '@google/genai';
import type { LoadedSettings } from '../config/settings.js';
import { SettingScope } from '../config/settings.js';
import {
  RequestPermissionResponseSchema,
  buildUsageUpdate,
  confirmationRequiresCallerApproval,
  toToolCallContent,
  toPermissionOptions,
  toAcpToolKind,
} from './acpUtils.js';
import { getAcpErrorMessage } from './acpErrors.js';

/**
 * Slice a persisted `SessionData.history` array (the UI-shape one stored at
 * `<sessionDir>/history.json`) so it ends just before the
 * `keepUserMessageCount`-th user-typed entry.
 *
 * Tolerates both shapes the SessionManager produces:
 *   1. Ink/gemini-cli style: `{ type: 'user' | 'gemini' | 'info' | ... }`.
 *      We count `type === 'user'`. Slash-only / question-only inputs are
 *      *also* counted because they appear as bubbles in the IDE's
 *      transcript — `keepUserMessageCount` should match exactly what the
 *      caller sees on screen.
 *   2. Native Gemini style: `{ role: 'user' | 'model', parts: [...] }`,
 *      same convention as `Session.rewindToBeforeUserMessage` — a
 *      `role:'user'` entry that contains a `functionResponse` part is a
 *      tool-result turn, not a real user input, and is skipped.
 *
 * Anything we don't recognise is preserved as part of the prefix (it
 * trails the most recent counted user entry until we hit the next one).
 *
 * Exported for unit testing.
 */
export function truncateUiHistoryByUserMessageCount(
  history: ReadonlyArray<Record<string, unknown>>,
  keepUserMessageCount: number,
): Array<Record<string, unknown>> {
  if (keepUserMessageCount <= 0) return [];

  let userSeen = 0;
  for (let i = 0; i < history.length; i++) {
    const entry = history[i] ?? {};
    const isCountable =
      entry['type'] === 'user' ||
      (entry['role'] === 'user' &&
        !(entry['parts'] as Array<Record<string, unknown>> | undefined)?.some(
          (p) => p && 'functionResponse' in p,
        ));
    if (!isCountable) continue;
    if (userSeen === keepUserMessageCount) {
      return history.slice(0, i);
    }
    userSeen += 1;
  }
  return [...history];
}

/**
 * One live ACP chat session.
 *
 * Owns:
 *   - the backing `OttoChat` (the LLM conversation)
 *   - an `AbortController` that ties a single prompt turn's lifetime together
 *   - forwarding of approval-mode events back to the IDE via `sessionUpdate`
 *
 * Lifecycle:
 *   `new Session(...)` → `.prompt(...)` many times → `.dispose()` (called by
 *   `AcpSessionManager` when the connection closes).
 */
export class Session {
  private pendingAbort?: AbortController;
  private readonly approvalModeUnsubscribe: () => void;
  /**
   * Runtime cache of session/set_config_option values. Used to answer
   * subsequent `set_config_option` responses with the `currentValue` the
   * client expects.
   */
  private readonly configValues = new Map<string, string | boolean>();

  constructor(
    readonly id: string,
    private readonly chat: OttoChat,
    private readonly config: Config,
    private readonly connection: acp.AgentSideConnection,
    private readonly _settings: LoadedSettings,
    /**
     * Working directory the surrounding ACP session was created with
     * (`session/new#cwd` / `session/load#cwd`). Used so that the persistence
     * writes inside `rewindToBeforeUserMessage` hit the *same* on-disk
     * `<projectTempDir>/sessions/<sessionId>/` that `loadSession` originally
     * read from. Falls back to `Config.getProjectRoot()` when not supplied —
     * both should resolve to the same path in practice but we don't want
     * truncation to silently drift to a different directory if they ever
     * diverge.
     */
    private readonly cwd?: string,
  ) {
    this.approvalModeUnsubscribe = coreEvents.on(
      CoreEvent.ApprovalModeChanged,
      (payload) => {
        if (payload.sessionId && payload.sessionId !== this.id) return;
        void this.sendUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `[MODE_UPDATE] ${payload.mode}`,
          },
        });
      },
    );
  }

  dispose(): void {
    this.pendingAbort?.abort();
    this.pendingAbort = undefined;
    this.approvalModeUnsubscribe();
  }

  async cancelPendingPrompt(): Promise<void> {
    this.pendingAbort?.abort();
    this.pendingAbort = undefined;
  }

  /**
   * Truncate the chat history to the prefix that ends just before the
   * `beforeUserMessageIndex`-th user message (0-based). Used by the ACP
   * `_otto/session/rewind` extension method so an IDE that "rewound" its
   * UI also makes the agent forget the trailing exchange.
   *
   * Why mutate `chat.setHistory` directly (instead of `client.resumeChat`):
   *   `resumeChat` rebuilds an entirely new `OttoChat` and swaps it onto
   *   the shared `OttoClient`. Any prior `Session` (incl. *this* one) keeps
   *   a `private readonly chat` reference to the *old* chat object, so the
   *   rewind would only take effect for sessions created *after* the swap.
   *   Going through `setHistory` keeps the same `OttoChat` instance and
   *   guarantees the next prompt sees the truncated history.
   *
   * Persistence: in addition to the in-memory truncation, this method also
   * overwrites `<projectTempDir>/sessions/<sessionId>/{history,context}.json`
   * via {@link CoreSessionManager.saveSessionHistory} so that:
   *   - the next `session/load` for the same id surfaces the truncated
   *     transcript instead of the full pre-rewind one ("history coming
   *     back from the dead"), and
   *   - `history.json` (UI shape) and `context.json` (Gemini `Content[]`)
   *     stay coherent — they are sliced at the same logical user-message
   *     index. Without this, the UI replay would show a truncated
   *     transcript while the next prompt still sends the full pre-rewind
   *     conversation to the model.
   *
   * Persistence failures are logged but never propagated — a successful
   * in-memory truncation is more important than the disk write succeeding,
   * and the disk view will eventually re-converge on the next save.
   *
   * Returns the number of `Content` entries kept after the truncation, so
   * the RPC can report it back to the client.
   */
  async rewindToBeforeUserMessage(beforeUserMessageIndex: number): Promise<{
    keptContentCount: number;
    keptUserMessageCount: number;
    droppedContentCount: number;
    persisted: boolean;
  }> {
    if (
      !Number.isFinite(beforeUserMessageIndex) ||
      beforeUserMessageIndex < 0
    ) {
      throw new acp.RequestError(
        -32602,
        `Invalid beforeUserMessageIndex: ${beforeUserMessageIndex}`,
      );
    }

    // Cancel any pending prompt — its outputContent could otherwise land
    // *after* our truncation when the model finishes streaming.
    this.pendingAbort?.abort();
    this.pendingAbort = undefined;

    const history = this.chat.getHistory(false);

    // Find the position in the curated history that corresponds to the
    // requested user-message index. We scan top-down: each `role: 'user'`
    // entry that does NOT start with a `functionResponse` part counts as a
    // "real user message" — the others are tool-result turns and shouldn't
    // be exposed as rewind anchors.
    let userMessageSeen = 0;
    let cutAt = history.length;
    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      const isUserText =
        entry.role === MESSAGE_ROLES.USER &&
        !(entry.parts ?? []).some(
          (p) => (p as { functionResponse?: unknown }).functionResponse,
        );
      if (!isUserText) continue;
      if (userMessageSeen === beforeUserMessageIndex) {
        cutAt = i;
        break;
      }
      userMessageSeen += 1;
    }

    const truncated = history.slice(0, cutAt);
    this.chat.setHistory(truncated);

    const keptUserMessageCount = Math.min(
      userMessageSeen,
      beforeUserMessageIndex,
    );
    const persisted = await this.persistTruncatedHistory(
      truncated,
      keptUserMessageCount,
    );

    return {
      keptContentCount: truncated.length,
      keptUserMessageCount,
      droppedContentCount: history.length - truncated.length,
      persisted,
    };
  }

  /**
   * Overwrite the on-disk `history.json` + `context.json` with the
   * post-rewind state. See {@link rewindToBeforeUserMessage} for the
   * persistence rationale.
   *
   * Strategy:
   *   - `clientHistory` (`context.json`) gets the freshly-truncated
   *     in-memory `Content[]` straight from `OttoChat.getHistory()` —
   *     this is the array the model will see on the next prompt, so it
   *     IS the source of truth.
   *   - `history` (`history.json`) is loaded from disk and sliced to the
   *     same logical "before the N-th user bubble" cut-point. We have no
   *     in-memory mirror of the UI history in ACP mode (unlike the Ink
   *     CLI's `useSessionAutoSave` hook), but the disk copy was last
   *     written by either an Ink session that owned this id or by an
   *     earlier rewind, so it's authoritative for UI shape.
   *
   * If `history.json` does not exist yet (pure ACP session that never
   * went through `useSessionAutoSave`), we still write `context.json` and
   * a synthetic empty `history` — a missing UI history is better than a
   * stale one. Returns `true` iff both writes succeeded.
   */
  private async persistTruncatedHistory(
    truncatedClientHistory: Content[],
    keptUserMessageCount: number,
  ): Promise<boolean> {
    const projectRoot = this.cwd ?? this.config.getProjectRoot?.();
    if (!projectRoot) {
      this.debug('persistTruncatedHistory skipped: no projectRoot');
      return false;
    }

    try {
      const mgr = new CoreSessionManager(projectRoot);
      const existing = await mgr.loadSession(this.id);
      const truncatedUiHistory = truncateUiHistoryByUserMessageCount(
        (existing?.history as unknown as Array<Record<string, unknown>>) ?? [],
        keptUserMessageCount,
      );
      await mgr.saveSessionHistory(
        this.id,
        truncatedUiHistory,
        truncatedClientHistory,
      );
      return true;
    } catch (err) {
      // Best-effort: a failed disk write must not abort the in-memory
      // rewind. Worst case the next save (model switch, next ACP rewind,
      // or an Ink autosave if the same project is opened in TUI) will
      // re-converge `history.json`/`context.json` to the truncated state.
      this.debug(
        `persistTruncatedHistory failed: ${getAcpErrorMessage(err)}`,
      );
      return false;
    }
  }

  setMode(modeId: string): void {
    // DeepCode's ApprovalMode uses upper-case ids; ACP clients send back the
    // same ids we advertised via `buildAvailableModes`, so we coerce in place
    // and let `Config.setApprovalMode` validate.
    const cfg = this.config as unknown as {
      setApprovalMode?: (mode: string) => void;
    };
    cfg.setApprovalMode?.(modeId);
  }

  /**
   * Switch the active model for this session.
   *
   * Mirrors the interactive CLI path (`useModelCommand` → `OttoClient.switchModel`):
   *   - compresses chat history to fit the new model's context window
   *   - re-registers tools (Claude vs Gemini need different tool schemas)
   *   - pushes a `[Model switched from X to Y]` system message into history
   *   - only then mutates `Config.setModel` + `OttoChat.setSpecifiedModel`
   *
   * Falls back to a pure `Config.setModel` + `chat.setSpecifiedModel` when
   * `OttoClient.switchModel` is unavailable (shouldn't happen in prod, but
   * keeps this callable in minimal test harnesses).
   *
   * Returns a {@link ModelSwitchResult}-shaped object when the full switch
   * path runs so callers can surface compression info / errors. Returns
   * `null` when the simple fallback is used.
   */
  async setModel(
    modelId: string,
    abortSignal?: AbortSignal,
  ): Promise<{
    success: boolean;
    error?: string;
    compressionInfo?: { originalTokenCount: number; newTokenCount: number };
    compressionSkipReason?: string;
  } | null> {
    const cfg = this.config as unknown as {
      setModel?: (modelId: string) => void;
      getOttoClient?: () => {
        switchModel?: (
          newModel: string,
          signal: AbortSignal,
          knownTokenCount?: number,
        ) => Promise<{
          success: boolean;
          error?: string;
          compressionInfo?: {
            originalTokenCount: number;
            newTokenCount: number;
          };
          compressionSkipReason?: string;
        }>;
      };
    };

    const client = cfg.getOttoClient?.();
    const signal = abortSignal ?? new AbortController().signal;

    if (client?.switchModel) {
      const result = await client.switchModel(modelId, signal);
      // switchModel already does config.setModel + chat.setSpecifiedModel +
      // setTools + history compression internally on success.
      if (result?.success !== false) this.persistPreferredModel(modelId);
      return result;
    }

    // Minimal fallback — Config only, no compression, no tool re-registration.
    cfg.setModel?.(modelId);
    const chat = this.chat as unknown as {
      setSpecifiedModel?: (modelId: string) => void;
    };
    chat.setSpecifiedModel?.(modelId);
    this.persistPreferredModel(modelId);
    return null;
  }

  /**
   * Write the active model id into user-scope settings so the next otto
   * process (TUI or ACP) comes up with the same model selected. This
   * mirrors what `useModelCommand` / `/model` does in the interactive CLI:
   * picking a model from the ACP picker is a persistent preference, not a
   * one-off session option.
   */
  private persistPreferredModel(modelId: string): void {
    try {
      this._settings.setValue(SettingScope.User, 'preferredModel', modelId);
    } catch (e) {
      // Non-fatal: the in-memory switch already succeeded. Just log.
      process.stderr.write(
        `[acp] failed to persist preferredModel=${modelId}: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  }

  /**
   * Apply a single `session/set_config_option` request.
   *
   * Known configIds are routed to their real backing setter:
   *   - `"model"`     → `OttoClient.switchModel` (full compression-aware path)
   *   - `"mode"`      → `Config.setApprovalMode`
   *
   * Everything else is cached on the session (so `buildConfigOptionsSnapshot`
   * can echo it back) but has no runtime effect yet. That's fine — ACP
   * clients pre-read the option schema from `newSession`'s `configOptions`,
   * so unknown options never reach this method in the first place.
   *
   * Returns extra metadata from the backing setter so the RPC layer can
   * surface compression info (`configOptions` is too rigid for that).
   */
  async applyConfigOption(
    configId: string,
    value: string | boolean,
  ): Promise<{
    compressionInfo?: { originalTokenCount: number; newTokenCount: number };
    compressionSkipReason?: string;
    error?: string;
  }> {
    this.configValues.set(configId, value);
    if (configId === 'model' && typeof value === 'string') {
      const result = await this.setModel(value);
      if (result && !result.success) {
        // Switch was vetoed (compression failed etc.) — roll back the cache
        // so `buildConfigOptionsSnapshot` keeps reflecting the real state.
        this.configValues.delete(configId);
        return { error: result.error };
      }
      return {
        compressionInfo: result?.compressionInfo,
        compressionSkipReason: result?.compressionSkipReason,
      };
    } else if (configId === 'mode' && typeof value === 'string') {
      this.setMode(value);
    }
    return {};
  }

  /** Currently-cached value of a configOption, falling back to `defaultValue`. */
  getConfigValue<T extends string | boolean>(
    configId: string,
    defaultValue: T,
  ): T {
    const v = this.configValues.get(configId);
    return (v ?? defaultValue) as T;
  }

  /** Dump of everything set so far — exposed for snapshot helpers. */
  getAllConfigValues(): ReadonlyMap<string, string | boolean> {
    return this.configValues;
  }

  /**
   * Stream back previously-persisted messages so the IDE can rehydrate its
   * transcript view on `session/load`.
   */
  async streamHistory(messages: readonly unknown[]): Promise<void> {
    for (const raw of messages) {
      const msg = raw as {
        role?: string;
        parts?: Part[];
        content?: PartListUnion;
      };
      if (!msg) continue;
      const parts = Array.isArray(msg.parts)
        ? msg.parts
        : msg.content !== undefined
          ? ([] as Part[]).concat(
              typeof msg.content === 'string'
                ? [{ text: msg.content } as Part]
                : Array.isArray(msg.content)
                  ? (msg.content as Part[])
                  : [msg.content as Part],
            )
          : [];
      const text = parts
        .map((p) => (typeof (p as { text?: string }).text === 'string'
          ? (p as { text: string }).text
          : ''))
        .join('');
      if (!text) continue;
      await this.sendUpdate(
        msg.role === 'user'
          ? {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text },
            }
          : {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
      );
    }
  }

  /**
   * Emit the current list of slash commands to the IDE. DeepCode's ACP layer
   * only ships a minimal set of built-ins (`/help`, `/memory`, `/init`,
   * `/about`); the richer registry from gemini-cli can be plugged in via
   * `acpCommandHandler.ts`.
   */
  async sendAvailableCommands(): Promise<void> {
    // Discover commands via the CommandHandler if present; fall back to a
    // static list so the IDE UI is never empty.
    let commands: Array<{ name: string; description: string }> = [];
    try {
      const { CommandHandler } = await import('./acpCommandHandler.js');
      commands = new CommandHandler().getAvailableCommands();
    } catch {
      commands = [
        { name: 'help', description: 'List available commands' },
        { name: 'about', description: 'Show version / environment info' },
        { name: 'memory show', description: 'Show current memory' },
        { name: 'init', description: 'Generate a OTTO.md for this project' },
      ];
    }
    await this.sendUpdate({
      sessionUpdate: 'available_commands_update',
      availableCommands: commands.map((c) => ({
        name: c.name,
        description: c.description,
      })),
    });
  }

  /**
   * Main prompt turn. Consumes `OttoChat.sendMessageStream`, relays chunks
   * as `session/update` notifications, and loops while the model issues
   * function calls.
   */
  async prompt(req: acp.PromptRequest): Promise<acp.PromptResponse> {
    // Intercept slash commands before touching the LLM.
    const textChunks = req.prompt
      .filter((c) => (c as { type?: string }).type === 'text')
      .map((c) => (c as { text: string }).text)
      .join('')
      .trim();
    if (textChunks.startsWith('/') || textChunks.startsWith('$')) {
      try {
        const { CommandHandler } = await import('./acpCommandHandler.js');
        const handler = new CommandHandler();
        const handled = await handler.handleCommand(textChunks, {
          config: this.config,
          settings: this._settings,
          sendMessage: async (text) => {
            await this.sendUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            });
          },
        });
        if (handled) {
          return { stopReason: 'end_turn' };
        }
      } catch {
        // Fall through to LLM path if command handling fails entirely.
      }
    }

    this.pendingAbort?.abort();
    const abort = new AbortController();
    this.pendingAbort = abort;

    const promptId = Math.random().toString(16).slice(2);
    const parts = await this.resolvePrompt(req, abort.signal);

    let nextMessage: Content | null = {
      role: MESSAGE_ROLES.USER,
      parts,
    };

    try {
      while (nextMessage !== null) {
        if (abort.signal.aborted) {
          return { stopReason: 'cancelled' };
        }
        const functionCalls: FunctionCall[] = [];
        // Collected stream chunks for this turn — used to extract the
        // model's `usageMetadata` after the stream completes so we can
        // emit a `session/update#usage_update` with up-to-date context
        // window stats (see `emitUsageUpdate` below).
        const streamChunks: GenerateContentResponse[] = [];
        try {
          const toolRegistry = await this.config.getToolRegistry();
          const stream = await this.chat.sendMessageStream(
            {
              message: nextMessage.parts ?? [],
              config: {
                abortSignal: abort.signal,
                tools: [
                  {
                    functionDeclarations:
                      toolRegistry.getFunctionDeclarations(),
                  },
                ],
              },
            },
            promptId,
            SceneType.CHAT_CONVERSATION,
          );
          nextMessage = null;
          for await (const resp of stream) {
            if (abort.signal.aborted) return { stopReason: 'cancelled' };
            streamChunks.push(resp);
            const candidate = resp.candidates?.[0];
            for (const part of candidate?.content?.parts ?? []) {
              if (!part.text) continue;
              await this.sendUpdate(
                part.thought
                  ? {
                      sessionUpdate: 'agent_thought_chunk',
                      content: { type: 'text', text: part.text },
                    }
                  : {
                      sessionUpdate: 'agent_message_chunk',
                      content: { type: 'text', text: part.text },
                    },
              );
            }
            if (resp.functionCalls) functionCalls.push(...resp.functionCalls);
          }
        } catch (err) {
          if (getErrorStatus(err) === 429) {
            throw new acp.RequestError(
              429,
              'Rate limit exceeded. Try again later.',
            );
          }
          throw err;
        }

        // After each model turn, emit a usage_update so the IDE can keep
        // its "ctx remaining" indicator in sync. Best-effort: a missing or
        // malformed usageMetadata just means we skip the emit.
        await this.emitUsageUpdate(streamChunks);

        if (functionCalls.length > 0) {
          const responseParts: Part[] = [];
          for (const fc of functionCalls) {
            const resp = await this.runTool(abort.signal, promptId, fc);
            const arr = Array.isArray(resp) ? resp : [resp];
            for (const part of arr) {
              if (typeof part === 'string') responseParts.push({ text: part });
              else if (part) responseParts.push(part);
            }
          }
          nextMessage = { role: MESSAGE_ROLES.USER, parts: responseParts };
        }
      }
      return { stopReason: 'end_turn' };
    } finally {
      if (this.pendingAbort === abort) this.pendingAbort = undefined;
    }
  }

  // --- private helpers ------------------------------------------------------

  private async sendUpdate(update: acp.SessionUpdate): Promise<void> {
    try {
      await this.connection.sessionUpdate({
        sessionId: this.id,
        update,
      });
    } catch (err) {
      // A failed update must not crash the prompt loop.
      this.debug(`sessionUpdate failed: ${getAcpErrorMessage(err)}`);
    }
  }

  /**
   * Aggregate `usageMetadata` from the just-completed stream and push a
   * `session/update#usage_update` event to the IDE. Mirrors the TUI's
   * "ctx remaining" indicator and the vscode-ui-plugin's `token_usage_update`
   * bus event — neither of which travelled over ACP before this method.
   *
   * Safe no-ops:
   *   - Empty `chunks` (e.g. cancelled before the model produced anything).
   *   - Stream missing `usageMetadata` entirely (some legacy proxy paths).
   *   - Helper returns `null` because we can't resolve a token limit yet.
   */
  private async emitUsageUpdate(
    chunks: GenerateContentResponse[],
  ): Promise<void> {
    if (chunks.length === 0) return;
    try {
      const usage = this.chat.getFinalUsageMetadata?.(chunks);
      const update = buildUsageUpdate(usage, this.config);
      if (update) await this.sendUpdate(update);
    } catch (err) {
      // Telemetry is best-effort — never let it break the prompt loop.
      this.debug(`emitUsageUpdate skipped: ${getAcpErrorMessage(err)}`);
    }
  }

  private async runTool(
    signal: AbortSignal,
    promptId: string,
    fc: FunctionCall,
  ): Promise<PartListUnion> {
    const callId = fc.id ?? `${fc.name ?? 'unknown'}-${Date.now()}`;
    const args = (fc.args ?? {}) as Record<string, unknown>;
    const startTime = Date.now();

    const errorResponse = (error: Error): PartListUnion => {
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        prompt_id: promptId,
        function_name: fc.name ?? '',
        function_args: args,
        duration_ms: Date.now() - startTime,
        success: false,
        error: error.message,
        response_length: error.message.length,
      });
      return [
        {
          functionResponse: {
            id: callId,
            name: fc.name ?? '',
            response: { error: error.message },
          },
        } as Part,
      ];
    };

    if (!fc.name) return errorResponse(new Error('Missing function name'));

    const toolRegistry = await this.config.getToolRegistry();
    const tool = toolRegistry.getTool(fc.name);
    if (!tool) {
      return errorResponse(
        new Error(`Tool "${fc.name}" not found in registry.`),
      );
    }

    const toolCallId = callId;
    const toolKind = toAcpToolKind(
      ((tool as unknown as { kind?: unknown }).kind as never) ??
        ('other' as never),
    );

    // Announce the tool call to the IDE.
    await this.sendUpdate({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: tool.getDescription?.(args) ?? fc.name,
      kind: toolKind,
      status: 'pending',
      locations: tool.toolLocations?.(args) ?? undefined,
    });

    // Confirm if necessary.
    //
    // ACP mode is agent-to-agent, so the calling agent is the "user". We
    // split confirmations into three buckets:
    //
    //   1. Auto-approve (no roundtrip): routine `edit`, `write`, generic
    //      `exec`, `mcp`, `info`. These are the tools that also auto-run
    //      under TUI YOLO mode. We just call `onConfirm(ProceedOnce)` so
    //      the tool's allowlist/state bookkeeping still runs.
    //
    //   2. Escalate to the caller agent via ACP `requestPermission`:
    //      - `exec` with a `warning` (dangerous-command-detector matched
    //        things like `rm -rf /`, `sudo`, fork bombs, etc.)
    //      - `delete` (irreversible)
    //      - `question` (`ask_user_question` — only the real user, i.e. the
    //        caller agent's own prompter, can meaningfully answer)
    //
    //   3. If `requestPermission` itself fails (old ACP clients don't
    //      implement it — they return "Permission prompt unavailable in
    //      non-interactive mode"), we fall back to rejecting the dangerous
    //      call. Auto-approved tools in bucket 1 never hit that path.
    const confirmation = await tool.shouldConfirmExecute(args, signal);
    if (confirmation) {
      const needsCallerApproval = confirmationRequiresCallerApproval(
        confirmation,
      );

      if (!needsCallerApproval) {
        // Bucket 1: silently proceed. Still invoke `onConfirm` so tools
        // that track allowlist state (shell's rootCommand allowlist,
        // ApprovalMode promotion on ProceedAlways) see the outcome.
        try {
          await confirmation.onConfirm(ToolConfirmationOutcome.ProceedOnce);
        } catch {
          // Non-fatal — onConfirm is usually a bookkeeping no-op.
        }
      } else {
        const options = toPermissionOptions(confirmation, this.config);
        try {
          const rawResp = await this.connection.requestPermission({
            sessionId: this.id,
            toolCall: {
              toolCallId,
              title: tool.getDescription?.(args) ?? fc.name,
              kind: toolKind,
            },
            options,
          });
          const parsed = RequestPermissionResponseSchema.parse(rawResp);
          if (parsed.outcome.outcome === 'cancelled') {
            await this.sendUpdate({
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'failed',
            });
            return errorResponse(
              new Error(`Tool "${fc.name}" was canceled by the user.`),
            );
          }
          const outcome = parsed.outcome.optionId as ToolConfirmationOutcome;
          if (outcome === ToolConfirmationOutcome.Cancel) {
            await confirmation.onConfirm(outcome);
            await this.sendUpdate({
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: 'failed',
            });
            return errorResponse(
              new Error(`Tool "${fc.name}" not allowed to run by the user.`),
            );
          }
          await confirmation.onConfirm(outcome);
        } catch (err) {
          // The ACP client couldn't/wouldn't surface the prompt. For
          // dangerous operations we must refuse — never silently run.
          await this.sendUpdate({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'failed',
          });
          const msg =
            err instanceof Error ? err.message : String(err);
          return errorResponse(
            new Error(
              `Tool "${fc.name}" requires approval but the ACP client cannot present one (${msg}). Refusing to run.`,
            ),
          );
        }
      }
    }

    // Execute.
    try {
      const result: ToolResult = await tool.execute(args, signal);
      const content = toToolCallContent(result);
      await this.sendUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: content ? [content] : undefined,
      });
      logToolCall(this.config, {
        'event.name': 'tool_call',
        'event.timestamp': new Date().toISOString(),
        prompt_id: promptId,
        function_name: fc.name,
        function_args: args,
        duration_ms: Date.now() - startTime,
        success: true,
        response_length:
          typeof result.llmContent === 'string'
            ? result.llmContent.length
            : JSON.stringify(result.llmContent ?? '').length,
      });
      return convertToFunctionResponse(fc.name, callId, result.llmContent);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      await this.sendUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: [
          { type: 'content', content: { type: 'text', text: error.message } },
        ],
      });
      return errorResponse(error);
    }
  }

  /**
   * Resolve `@path` references in the incoming prompt into real file content.
   *
   * Ported from the DeepCode legacy `acpPeer.ts#resolveUserMessage` — same
   * semantics, only the `ContentBlock` shape is adjusted for the new SDK.
   */
  private async resolvePrompt(
    req: acp.PromptRequest,
    signal: AbortSignal,
  ): Promise<Part[]> {
    const blocks = req.prompt;
    // New SDK exposes `resource_link { uri }` instead of the legacy `{ path }`.
    const atPathBlocks = blocks.filter((b) => {
      const type = (b as { type?: string }).type;
      return (
        type === 'resource_link' ||
        (b as { path?: unknown }).path !== undefined
      );
    });

    if (atPathBlocks.length === 0) {
      return blocks.flatMap((b) => {
        const type = (b as { type?: string }).type;
        if (type === 'text' || (b as { text?: unknown }).text !== undefined) {
          return [{ text: (b as { text: string }).text } as Part];
        }
        if (type === 'image') {
          const img = b as unknown as { mimeType?: string; data?: string };
          if (img.mimeType && img.data) {
            return [
              {
                inlineData: { mimeType: img.mimeType, data: img.data },
              } as Part,
            ];
          }
        }
        return [];
      });
    }

    const fileDiscovery = this.config.getFileService();
    const respectGitIgnore = this.config.getFileFilteringRespectGitIgnore();
    const pathSpecsToRead: string[] = [];
    const atPathToResolved = new Map<string, string>();
    const labels: string[] = [];
    const ignored: string[] = [];

    const toolRegistry = await this.config.getToolRegistry();
    const readManyFilesTool = toolRegistry.getTool('read_many_files');
    const globTool = toolRegistry.getTool('glob');
    if (!readManyFilesTool) {
      throw new Error('read_many_files tool not found.');
    }

    const extractPath = (b: unknown): string | undefined => {
      const x = b as { path?: string; uri?: string };
      if (typeof x.path === 'string') return x.path;
      if (typeof x.uri === 'string') {
        // strip a `file://` prefix if present.
        return x.uri.replace(/^file:\/\//, '');
      }
      return undefined;
    };

    for (const block of atPathBlocks) {
      const pathName = extractPath(block);
      if (!pathName) continue;

      if (fileDiscovery.shouldGitIgnoreFile(pathName)) {
        ignored.push(pathName);
        continue;
      }

      let currentPathSpec = pathName;
      let resolved = false;

      try {
        const absolute = path.resolve(this.config.getTargetDir(), pathName);
        if (isWithinRoot(absolute, this.config.getTargetDir())) {
          const stats = await fs.stat(absolute);
          if (stats.isDirectory()) {
            currentPathSpec = pathName.endsWith('/')
              ? `${pathName}**`
              : `${pathName}/**`;
          }
          resolved = true;
        }
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          if (this.config.getEnableRecursiveFileSearch() && globTool) {
            try {
              const globResult = await globTool.execute(
                { pattern: `**/*${pathName}*`, path: this.config.getTargetDir() },
                signal,
              );
              if (
                typeof globResult.llmContent === 'string' &&
                !globResult.llmContent.startsWith('No files found') &&
                !globResult.llmContent.startsWith('Error:')
              ) {
                const lines = globResult.llmContent.split('\n');
                if (lines.length > 1 && lines[1]) {
                  currentPathSpec = path.relative(
                    this.config.getTargetDir(),
                    lines[1].trim(),
                  );
                  resolved = true;
                }
              }
            } catch {
              // glob failed; path is skipped.
            }
          }
        }
      }

      if (resolved) {
        pathSpecsToRead.push(currentPathSpec);
        atPathToResolved.set(pathName, currentPathSpec);
        labels.push(pathName);
      }
    }

    // Re-assemble the query text, substituting resolved specs for @-paths.
    let queryText = '';
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if ((block as { text?: string }).text !== undefined) {
        queryText += (block as { text: string }).text;
        continue;
      }
      const raw = extractPath(block);
      if (!raw) continue;
      const resolvedSpec = atPathToResolved.get(raw);
      if (
        i > 0 &&
        queryText.length > 0 &&
        !queryText.endsWith(' ')
      ) {
        queryText += ' ';
      }
      queryText += `@${resolvedSpec ?? raw}`;
    }
    queryText = queryText.trim();

    if (ignored.length > 0) {
      this.debug(
        `Ignored ${ignored.length} path(s) (${respectGitIgnore ? 'git-ignored' : 'custom-ignored'}): ${ignored.join(', ')}`,
      );
    }

    if (pathSpecsToRead.length === 0) {
      return [{ text: queryText } as Part];
    }

    const parts: Part[] = [{ text: queryText } as Part];
    const toolArgs = { paths: pathSpecsToRead, respectGitIgnore };
    try {
      const result = await readManyFilesTool.execute(toolArgs, signal);
      if (Array.isArray(result.llmContent)) {
        const fileRe = /^--- (.*?) ---\n\n([\s\S]*?)\n\n$/;
        parts.push({ text: `\n${REFERENCE_CONTENT_START}` } as Part);
        for (const part of result.llmContent) {
          if (typeof part === 'string') {
            const m = fileRe.exec(part);
            if (m) {
              parts.push({ text: `\nContent from @${m[1]}:\n` } as Part);
              parts.push({ text: m[2].trim() } as Part);
            } else {
              parts.push({ text: part } as Part);
            }
          } else {
            parts.push(part);
          }
        }
        parts.push({ text: `\n${REFERENCE_CONTENT_END}` } as Part);
      }
    } catch (err) {
      this.debug(
        `Error reading referenced files (${labels.join(', ')}): ${getErrorMessage(err)}`,
      );
    }
    return parts;
  }

  private debug(msg: string): void {
    if (this.config.getDebugMode()) {
      // stderr so we don't corrupt the ACP stdout frames.
      console.error(`[acp:${this.id}] ${msg}`);
    }
  }

  // Silence the unused-import linter for AuthType; it's re-exported by
  // session manager and kept here for future auth-override hooks.
  private readonly _authTypeRef = _AuthType;
}

export type { _AuthType };
