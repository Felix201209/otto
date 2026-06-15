/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GeminiClient } from '../core/client.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { ResourceRegistry } from '../resources/resource-registry.js';
import type { Config } from './config.js';

/**
 * Execution-scoped view of the world for a single agent turn or sub-agent loop.
 *
 * ACP sessions carry one of these alongside the RPC connection so any layer
 * (prompt loop, tool execution, command handling) can reach the same `Config`,
 * `GeminiClient`, registries, etc. without passing seven-argument parameter
 * lists around.
 *
 * The `messageBus` and `sandboxManager` slots are declared loosely (using
 * `unknown` / `object`) so code can construct an `AgentLoopContext` before
 * those subsystems land — they are added in later phases.
 */
export interface AgentLoopContext {
  /** The global runtime configuration. */
  readonly config: Config;

  /** The unique ID for the current user turn or agent thought loop. */
  readonly promptId: string;

  /** The unique ID for the parent session if this is a subagent. */
  readonly parentSessionId?: string;

  /** The registry of tools available to the agent in this context. */
  readonly toolRegistry: ToolRegistry;

  /** The registry of prompts available to the agent in this context. */
  readonly promptRegistry?: PromptRegistry;

  /** The registry of resources available to the agent in this context. */
  readonly resourceRegistry?: ResourceRegistry;

  /**
   * The confirmation / message bus. Populated once the MessageBus subsystem
   * ships; ACP code treats this as optional and falls back to direct
   * connection calls when absent.
   */
  readonly messageBus?: unknown;

  /** The client used to communicate with the LLM in this context. */
  readonly geminiClient: GeminiClient;

  /**
   * The service used to prepare commands for sandboxed execution.
   * Optional for now — not all DeepCode deployments run with a sandbox.
   */
  readonly sandboxManager?: unknown;
}
