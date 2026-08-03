/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Structured error system for Otto tools.
 * Replaces bare string errors with typed codes the AI can programmatically react to.
 */

export enum ToolErrorCode {
  // Validation errors
  PARAM_MISSING       = 'PARAM_MISSING',
  PARAM_INVALID       = 'PARAM_INVALID',
  FILE_NOT_FOUND      = 'FILE_NOT_FOUND',
  PATH_NOT_ABSOLUTE   = 'PATH_NOT_ABSOLUTE',
  PLATFORM_UNSUPPORTED = 'PLATFORM_UNSUPPORTED',

  // Runtime errors
  TOOL_NOT_INSTALLED  = 'TOOL_NOT_INSTALLED',
  PROCESS_TIMEOUT     = 'PROCESS_TIMEOUT',
  APP_NOT_RUNNING     = 'APP_NOT_RUNNING',
  PERMISSION_DENIED   = 'PERMISSION_DENIED',

  // Execution errors
  EXECUTION_FAILED    = 'EXECUTION_FAILED',
  UNKNOWN_ACTION      = 'UNKNOWN_ACTION',
  PARSE_ERROR         = 'PARSE_ERROR',
}

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly userMessage: string;
  readonly fixHint?: string;
  readonly llmContext?: string;
  readonly cause?: unknown;

  constructor(
    code: ToolErrorCode,
    userMessage: string,
    options?: { fixHint?: string; llmContext?: string; cause?: unknown },
  ) {
    super(userMessage);
    this.name = 'ToolError';
    this.code = code;
    this.userMessage = userMessage;
    this.fixHint = options?.fixHint;
    this.llmContext = options?.llmContext;
    this.cause = options?.cause;
  }

  /** Format for returnDisplay (user-facing, one line) */
  toUserString(toolName: string): string {
    let s = `${toolName} FAIL [${this.code}]: ${this.userMessage}`;
    if (this.fixHint) s += ` (fix: ${this.fixHint})`;
    return s;
  }

  /** Format for llmContent (AI-facing, full detail) */
  toLLMString(toolName: string): string {
    let s = `${toolName} FAIL [${this.code}]: ${this.userMessage}`;
    if (this.fixHint) s += `\nFix: ${this.fixHint}`;
    if (this.llmContext) s += `\nContext: ${this.llmContext}`;
    if (this.cause) s += `\nCause: ${this.cause}`;
    return s;
  }

  /** Check if an error should trigger user confirmation */
  isRetryable(): boolean {
    return [ToolErrorCode.PROCESS_TIMEOUT, ToolErrorCode.TOOL_NOT_INSTALLED].includes(this.code);
  }

  /** Check if the error is a missing dependency */
  isMissingDep(): boolean {
    return this.code === ToolErrorCode.TOOL_NOT_INSTALLED;
  }
}
