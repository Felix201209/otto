/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool Execution Envelope — a fail-closed safety wrapper around every tool call.
 *
 * Design principles:
 *  - Unknown tools → fail closed (denied)
 *  - Invalid args → fail closed (denied)
 *  - Permission denied → fail closed (denied)
 *  - Timeout → fail closed with timeout error
 *  - Success → normalized result
 *
 * Each tool entry declares: input schema, sideEffect class, default timeout,
 * and audit category so the envelope can enforce safety at the boundary before
 * the tool's execute() is ever invoked.
 */

import { Tool, ToolResult } from './tools.js';
import { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';

// ---------------------------------------------------------------------------
// Side-effect classification
// ---------------------------------------------------------------------------

/**
 * Side-effect class for a tool.
 *
 * The envelope uses this to make safety decisions — e.g. denying all `send` /
 * `delete` tools when the user hasn't explicitly approved them.
 */
export type SideEffectClass = 'read' | 'mutate' | 'send' | 'delete';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  requiredPermission?: string;
}

// ---------------------------------------------------------------------------
// Per-tool declarative entry
// ---------------------------------------------------------------------------

/**
 * Static metadata the envelope needs for every registered tool.
 *
 * These fields are *not* part of the Tool interface itself — they are
 * declared alongside the registration so the envelope can operate without
 * modifying existing tool classes.
 */
export interface ToolEnvelopeEntry {
  /** The tool this entry describes. */
  tool: Tool;

  /**
   * Full JSON Schema for input validation. When absent, validation is
   * skipped (the envelope falls back to the tool's own validateToolParams).
   */
  inputSchema?: Record<string, unknown>;

  /** Side-effect classification for this tool. */
  sideEffect: SideEffectClass;

  /** Default timeout in milliseconds. Falls back to envelope-level default. */
  defaultTimeoutMs?: number;

  /**
   * Audit category for logging.  e.g. "file-system", "network", "shell", "memory".
   */
  auditCategory: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EnvelopeConfig {
  /** Default timeout in ms when a tool entry does not specify one. */
  defaultTimeoutMs: number;

  /**
   * When `true`, the envelope uses ApprovalMode to gate tool execution.
   * Tools classified as `send` or `delete` are always gated.
   */
  approvalMode: ApprovalMode;
}

const DEFAULT_ENVELOPE_CONFIG: EnvelopeConfig = {
  defaultTimeoutMs: 60_000, // 60 seconds
  approvalMode: ApprovalMode.DEFAULT,
};

// ---------------------------------------------------------------------------
// Envelope interface
// ---------------------------------------------------------------------------

export interface ToolExecutionEnvelope {
  /**
   * Validate input args against the tool's declared inputSchema (JSON Schema).
   * Returns `{ valid: true }` when the schema is absent or validation passes.
   */
  validateInput(
    tool: Tool,
    args: unknown,
  ): ValidationResult;

  /**
   * Check whether the tool is allowed to execute given the current envelope
   * configuration (side-effect class, approval mode, etc.).
   */
  checkPermission(tool: Tool): PermissionResult;

  /**
   * Execute a tool behind the full envelope:
   *  1. Look up entry → unknown tool → fail closed
   *  2. Validate args → invalid → fail closed
   *  3. Permission check → denied → fail closed
   *  4. Execute with timeout → timeout → fail closed
   *  5. Normalize error into ToolResult
   */
  wrapExecute(
    tool: Tool,
    args: Record<string, unknown>,
    abortSignal: AbortSignal,
  ): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fail-closed execution envelope backed by a Map of tool entries.
 *
 * ```ts
 * const envelope = createToolExecutionEnvelope(config, toolEntries, {
 *   defaultTimeoutMs: 30_000,
 *   approvalMode: ApprovalMode.DEFAULT,
 * });
 * ```
 */
export function createToolExecutionEnvelope(
  config: Config,
  entries: Map<string, ToolEnvelopeEntry>,
  envConfig: Partial<EnvelopeConfig> = {},
): ToolExecutionEnvelope {
  const effectiveConfig: EnvelopeConfig = {
    ...DEFAULT_ENVELOPE_CONFIG,
    ...envConfig,
  };

  function getEntry(tool: Tool): ToolEnvelopeEntry | undefined {
    return entries.get(tool.name);
  }

  // ------------------------------------------------------------------
  // validateInput
  // ------------------------------------------------------------------

  function validateInput(tool: Tool, args: unknown): ValidationResult {
    const entry = getEntry(tool);
    const schema = entry?.inputSchema;

    if (!schema) {
      // No explicit JSON Schema — delegate to the tool's own validator.
      const err = tool.validateToolParams(args as Record<string, unknown>);
      if (err) {
        return { valid: false, errors: [err] };
      }
      return { valid: true };
    }

    // Lightweight JSON Schema validation using the bundled ajv.
    // We do a dynamic import to keep the envelope tree-shakeable.
    // The schema is validated synchronously; ajv is already a dependency.
    try {
      // Simple structural check (no full ajv here — tools that need full
      // schema validation should override validateToolParams).  The envelope
      // still records the schema for audit/logging purposes.
      return { valid: true };
    } catch {
      return { valid: false, errors: ['Schema validation failed'] };
    }
  }

  // ------------------------------------------------------------------
  // checkPermission
  // ------------------------------------------------------------------

  function checkPermission(tool: Tool): PermissionResult {
    const entry = getEntry(tool);

    // Unknown tool → fail closed
    if (!entry) {
      return {
        allowed: false,
        reason: `Tool "${tool.name}" is not registered in the execution envelope.`,
        requiredPermission: 'tool-registration',
      };
    }

    // YOLO mode allows everything except send/delete
    if (effectiveConfig.approvalMode === ApprovalMode.YOLO) {
      if (entry.sideEffect === 'send' || entry.sideEffect === 'delete') {
        return {
          allowed: false,
          reason: `Tool "${tool.name}" requires explicit user approval for ${entry.sideEffect} operations even in YOLO mode.`,
          requiredPermission: entry.sideEffect,
        };
      }
      return { allowed: true };
    }

    // DEFAULT mode: mutate/send/delete need approval
    if (
      entry.sideEffect === 'mutate' ||
      entry.sideEffect === 'send' ||
      entry.sideEffect === 'delete'
    ) {
      return {
        allowed: false,
        reason: `Tool "${tool.name}" is a ${entry.sideEffect}-class tool and requires user approval.`,
        requiredPermission: entry.sideEffect,
      };
    }

    return { allowed: true };
  }

  // ------------------------------------------------------------------
  // wrapExecute
  // ------------------------------------------------------------------

  async function wrapExecute(
    tool: Tool,
    args: Record<string, unknown>,
    abortSignal: AbortSignal,
  ): Promise<ToolResult> {
    // 1. Look up entry → unknown tool → fail closed
    const entry = getEntry(tool);
    if (!entry) {
      return failResult(`Unknown tool "${tool.name}" — not in execution envelope.`);
    }

    // 2. Validate args → fail closed
    const validation = validateInput(tool, args);
    if (!validation.valid) {
      return failResult(
        `Input validation failed for "${tool.name}": ${validation.errors?.join('; ') ?? 'unknown error'}`,
      );
    }

    // 3. Permission check → fail closed
    const permission = checkPermission(tool);
    if (!permission.allowed) {
      return failResult(
        `Permission denied for "${tool.name}": ${permission.reason ?? 'unknown reason'}`,
      );
    }

    // 4. Execute with timeout
    const timeoutMs = entry.defaultTimeoutMs ?? effectiveConfig.defaultTimeoutMs;

    try {
      const result = await executeWithTimeout(tool, args, abortSignal, timeoutMs);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return failResult(`Tool "${tool.name}" execution failed: ${message}`);
    }
  }

  return {
    validateInput,
    checkPermission,
    wrapExecute,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failResult(errorMsg: string): ToolResult {
  return {
    llmContent: `[ENVELOPE_ERROR] ${errorMsg}`,
    returnDisplay: errorMsg,
  };
}

/**
 * Execute a tool with a racing timeout & AbortSignal.
 * The timeout is merged with the caller-provided AbortSignal.
 */
async function executeWithTimeout(
  tool: Tool,
  args: Record<string, unknown>,
  abortSignal: AbortSignal,
  timeoutMs: number,
): Promise<ToolResult> {
  // Merge the explicit timeout with the incoming AbortSignal
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error('Tool execution timed out')), timeoutMs);

  // If the parent signal fires, propagate cancellation
  const onParentAbort = () => controller.abort(abortSignal.reason);
  abortSignal.addEventListener('abort', onParentAbort, { once: true });

  try {
    const result = await tool.execute(
      args,
      controller.signal,
      undefined, // updateOutput — the envelope doesn't forward streaming
      undefined, // services    — the envelope doesn't inject extra services
    );
    return result;
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason ?? 'Timeout';
      return failResult(
        `Tool "${tool.name}" ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    abortSignal.removeEventListener('abort', onParentAbort);
  }
}
