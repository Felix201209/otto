/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stream JSON Output Module - Gemini CLI Compatible
 * Formats output as streaming line-delimited JSON objects.
 * Each event is output as a single line of JSON, immediately flushed to stdout.
 *
 * Compatible with Google Gemini CLI JSON output format.
 *
 * Message deltas are buffered and flushed at sentence boundaries or on timeout,
 * reducing JSON line volume for downstream agent consumers.
 */

export type StreamJsonEventType =
  | 'init' // Session initialization
  | 'message' // AI/user message (with delta support)
  | 'tool_use' // Tool function call request
  | 'tool_result' // Tool execution result
  | 'function_call_fixed' // Function call was fixed due to format issues
  | 'error' // General error
  | 'result'; // Final result/statistics

export interface StreamJsonEvent {
  type: StreamJsonEventType;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Output a JSON event as a single line to stdout
 * Each line is automatically flushed for real-time streaming
 */
export function outputStreamJsonEvent(event: StreamJsonEvent): void {
  const json = JSON.stringify(event);
  process.stdout.write(json + '\n');
}

/**
 * Output initialization event
 * Should be called at the start of the session
 */
export function outputInit(sessionId: string, model: string): void {
  outputStreamJsonEvent({
    type: 'init',
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    model,
  });
}

/**
 * Output message event (user or assistant)
 * Supports delta updates for streaming responses
 */
export function outputMessage(
  role: 'user' | 'assistant',
  content: string,
  delta: boolean = false,
): void {
  outputStreamJsonEvent({
    type: 'message',
    timestamp: new Date().toISOString(),
    role,
    content,
    ...(delta && { delta: true }),
  });
}

/**
 * Output tool use request
 * Compatible with Gemini CLI format
 */
export function outputToolUse(
  toolName: string,
  toolId: string,
  parameters: Record<string, unknown>,
): void {
  outputStreamJsonEvent({
    type: 'tool_use',
    timestamp: new Date().toISOString(),
    tool_name: toolName,
    tool_id: toolId,
    parameters,
  });
}

/**
 * Output tool result
 * Compatible with Gemini CLI format
 */
export function outputToolResult(
  toolId: string,
  status: 'success' | 'error',
  output: unknown,
): void {
  outputStreamJsonEvent({
    type: 'tool_result',
    timestamp: new Date().toISOString(),
    tool_id: toolId,
    status,
    output,
  });
}

/**
 * Output function call fix notification
 */
export function outputFunctionCallFixed(
  callCount: number,
  reason: string,
): void {
  outputStreamJsonEvent({
    type: 'function_call_fixed',
    timestamp: new Date().toISOString(),
    data: {
      callCount,
      reason,
    },
  });
}

/**
 * Output error event
 */
export function outputError(error: string, details?: Record<string, unknown>): void {
  outputStreamJsonEvent({
    type: 'error',
    timestamp: new Date().toISOString(),
    error,
    ...(details && { details }),
  });
}

/**
 * Output final result with statistics
 */
export function outputResult(
  status: 'success' | 'error',
  stats?: Record<string, unknown>,
): void {
  outputStreamJsonEvent({
    type: 'result',
    timestamp: new Date().toISOString(),
    status,
    ...(stats && { stats }),
  });
}

/**
 * Output a single JSON object containing the complete response.
 * Used by --output-format json mode (non-streaming, final-result-only).
 */
export function outputFinalJson(result: {
  model: string;
  content: string;
  status: 'success' | 'error';
  error?: string;
}): void {
  const json = JSON.stringify(result);
  process.stdout.write(json + '\n');
}

// Sentence-ending punctuation that triggers a flush
const SENTENCE_BREAK_RE = /[。！？.!?\n]\s*$/;

// Code fence markers that trigger a flush (start or end of code block)
const CODE_FENCE_RE = /```[^\n]*\n?$/;

/**
 * Buffers assistant message deltas and flushes them in coarser chunks,
 * so downstream JSON consumers see sentence-level granularity instead of
 * per-token granularity.
 *
 * Flush triggers:
 *  1. Sentence-ending punctuation (。！？. ! ? or newline)
 *  2. Code fence boundaries (```)
 *  3. Timer-based timeout (default 300ms of silence)
 *  4. Manual flush() call (before tool calls, at end of turn, etc.)
 */
export class MessageBuffer {
  private buffer: string = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs: number;

  constructor(flushIntervalMs: number = 300) {
    this.flushIntervalMs = flushIntervalMs;
  }

  /**
   * Append a text chunk to the buffer.
   * May trigger an automatic flush if a sentence boundary is detected.
   */
  append(text: string): void {
    this.buffer += text;
    this.resetTimer();

    if (SENTENCE_BREAK_RE.test(this.buffer) || CODE_FENCE_RE.test(this.buffer)) {
      this.flush();
    }
  }

  /**
   * Force-flush whatever is in the buffer as a single delta message.
   * Safe to call even if the buffer is empty.
   */
  flush(): void {
    this.clearTimer();
    if (this.buffer.length > 0) {
      outputMessage('assistant', this.buffer, true);
      this.buffer = '';
    }
  }

  private resetTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.flush();
    }, this.flushIntervalMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
