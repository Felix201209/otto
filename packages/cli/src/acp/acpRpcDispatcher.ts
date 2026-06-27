/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, type Config, getVersion } from 'otto-core';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { SettingScope, type LoadedSettings } from '../config/settings.js';
import type { CliArgs } from '../config/config.js';
import { getAcpErrorMessage } from './acpErrors.js';
import { AcpSessionManager, type AuthDetails } from './acpSessionManager.js';
import { buildConfigOptionsSnapshot, hasMeta } from './acpUtils.js';

/**
 * Top-level ACP request handler — implements `acp.Agent`.
 *
 * The class owns the per-process `AcpSessionManager`. Every JSON-RPC method
 * defined by the `@agentclientprotocol/sdk` `Agent` contract is delegated to
 * the session manager (or to the specific `Session` for session-scoped
 * methods like `prompt` and `cancel`).
 *
 * NOTE: gemini-cli's version advertises multiple auth providers
 * (`LOGIN_WITH_GOOGLE`, `USE_GEMINI`, `USE_VERTEX_AI`, `GATEWAY`). DeepCode
 * has intentionally collapsed its auth model to a single `USE_PROXY_AUTH`
 * path; we keep that here and simply accept `apiKey` / `baseUrl` overrides
 * in `authenticate`.
 */
export class OttoAgent {
  private apiKey?: string;
  private baseUrl?: string;
  private customHeaders?: Record<string, string>;
  private readonly sessionManager: AcpSessionManager;

  constructor(
    private readonly config: Config,
    private readonly settings: LoadedSettings,
    argv: CliArgs,
    connection: acp.AgentSideConnection,
  ) {
    this.sessionManager = new AcpSessionManager(
      config,
      settings,
      argv,
      connection,
    );
  }

  dispose(): void {
    this.sessionManager.dispose();
  }

  async initialize(
    args: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    if (args.clientCapabilities) {
      this.sessionManager.setClientCapabilities(args.clientCapabilities);
    }

    const version = await getVersion().catch(() => 'unknown');

    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      authMethods: [
        {
          id: AuthType.USE_PROXY_AUTH,
          name: 'Otto proxy auth',
          description: 'Use Otto proxy authentication',
          _meta: {
            'api-key': {
              provider: 'otto',
            },
            gateway: {
              protocol: 'otto',
              restartRequired: 'false',
            },
          },
        },
      ],
      agentInfo: {
        name: 'otto',
        title: 'Otto',
        version,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
      },
    };
  }

  async authenticate(req: acp.AuthenticateRequest): Promise<void> {
    // DeepCode always resolves to USE_PROXY_AUTH, but we still accept any
    // method id clients may send (Zed, gemini-cli compat shims, etc.).
    const meta = hasMeta(req) ? req._meta : undefined;
    const apiKey =
      typeof meta?.['api-key'] === 'string' ? meta['api-key'] : undefined;

    if (apiKey) this.apiKey = apiKey;

    const gatewaySchema = z.object({
      baseUrl: z.string().optional(),
      headers: z.record(z.string()).optional(),
    });
    if (meta?.['gateway']) {
      const parsed = gatewaySchema.safeParse(meta['gateway']);
      if (!parsed.success) {
        throw new acp.RequestError(
          -32602,
          `Malformed gateway payload: ${parsed.error.message}`,
        );
      }
      this.baseUrl = parsed.data.baseUrl;
      this.customHeaders = parsed.data.headers;
    }

    try {
      await this.config.refreshAuth(AuthType.USE_PROXY_AUTH, {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        customHeaders: this.customHeaders,
      });
    } catch (e) {
      throw new acp.RequestError(-32000, getAcpErrorMessage(e));
    }

    this.settings.setValue(
      SettingScope.User,
      'selectedAuthType',
      AuthType.USE_PROXY_AUTH,
    );
  }

  private getAuthDetails(): AuthDetails {
    return {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      customHeaders: this.customHeaders,
    };
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    return this.sessionManager.newSession(params, this.getAuthDetails());
  }

  async loadSession(
    params: acp.LoadSessionRequest,
  ): Promise<acp.LoadSessionResponse> {
    return this.sessionManager.loadSession(params, this.getAuthDetails());
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw new acp.RequestError(
        -32602,
        `Session not found: ${params.sessionId}`,
      );
    }
    await session.cancelPendingPrompt();
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw new acp.RequestError(
        -32602,
        `Session not found: ${params.sessionId}`,
      );
    }
    return session.prompt(params);
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw new acp.RequestError(
        -32602,
        `Session not found: ${params.sessionId}`,
      );
    }
    session.setMode(params.modeId);
    return {};
  }

  /**
   * Handle `session/set_config_option`.
   *
   * DeepCode currently exposes one real configOption: `"model"`. Others are
   * accepted (cached on the session) but have no backing effect yet. The
   * response always contains the full, up-to-date `configOptions[]`
   * snapshot so the IDE's UI state stays in sync.
   */
  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw new acp.RequestError(
        -32602,
        `Session not found: ${params.sessionId}`,
      );
    }

    // Request is a discriminated union:
    //   {type: 'boolean', value: boolean, configId, sessionId}
    // | {value: SessionConfigValueId (string), configId, sessionId}
    const rawValue = (params as { value: unknown }).value;
    const configId = (params as { configId: string }).configId;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'boolean') {
      throw new acp.RequestError(
        -32602,
        `Unsupported value shape for config option "${configId}"`,
      );
    }

    try {
      const outcome = await session.applyConfigOption(configId, rawValue);
      if (outcome.error) {
        // Switch was vetoed by the compression-aware `OttoClient.switchModel`
        // (e.g. compression failed or already in progress). Surface this as
        // an RPC error so ACP clients can show a meaningful message.
        throw new acp.RequestError(
          -32603,
          `Failed to apply config option "${configId}": ${outcome.error}`,
        );
      }
    } catch (e) {
      if (e instanceof acp.RequestError) throw e;
      throw new acp.RequestError(-32603, getAcpErrorMessage(e));
    }

    return {
      configOptions: buildConfigOptionsSnapshot(
        this.config,
        session.getAllConfigValues(),
      ),
    };
  }

  async unstable_setSessionModel(
    params: acp.SetSessionModelRequest,
  ): Promise<acp.SetSessionModelResponse> {
    const session = this.sessionManager.getSession(params.sessionId);
    if (!session) {
      throw new acp.RequestError(
        -32602,
        `Session not found: ${params.sessionId}`,
      );
    }
    const result = await session.setModel(params.modelId);
    if (result && !result.success) {
      throw new acp.RequestError(
        -32603,
        `Failed to switch model to ${params.modelId}: ${result.error ?? 'unknown error'}`,
      );
    }
    return {};
  }

  /**
   * Fallback handler for non-standard ACP methods.
   *
   * The SDK's `AgentSideConnection` dispatcher hits this hook whenever it
   * sees a method name that isn't in its hardcoded `AGENT_METHODS` switch.
   * We use it to ship `_otto/*` extensions while staying inside the
   * standard JSON-RPC envelope — IDEs that don't know about them just get
   * a `methodNotFound` after the SDK strips the call here.
   *
   * Currently exposed:
   *   - `_otto/session/rewind` — truncate chat history before the
   *     N-th user message (0-based). Used by the IDE's "rewind" UI to keep
   *     the agent's view of history in sync with what the user sees.
   */
  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case '_otto/session/rewind':
        return this.handleRewind(params);
      default:
        throw new acp.RequestError(-32601, `Method not found: ${method}`);
    }
  }

  private async handleRewind(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const schema = z.object({
      sessionId: z.string(),
      // 0-based index of the user message to rewind *before*. `0` clears
      // history entirely; passing a value >= the user-message count is a
      // no-op (clamped to "history unchanged").
      beforeUserMessageIndex: z.number().int().nonnegative(),
    });
    const parsed = schema.safeParse(params);
    if (!parsed.success) {
      throw new acp.RequestError(
        -32602,
        `Invalid params for _otto/session/rewind: ${parsed.error.message}`,
      );
    }
    const session = this.sessionManager.getSession(parsed.data.sessionId);
    if (!session) {
      throw new acp.RequestError(
        -32602,
        `Session not found: ${parsed.data.sessionId}`,
      );
    }
    const stats = await session.rewindToBeforeUserMessage(
      parsed.data.beforeUserMessageIndex,
    );
    return {
      keptContentCount: stats.keptContentCount,
      keptUserMessageCount: stats.keptUserMessageCount,
      droppedContentCount: stats.droppedContentCount,
      persisted: stats.persisted,
    };
  }
}
