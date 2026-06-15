/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reason classification for {@link InvalidStreamError}.
 *
 * The ACP layer uses this to decide whether the condition is retryable and
 * what to surface to the user.
 */
export type InvalidStreamReason =
  | 'NO_FINISH_REASON'
  | 'NO_RESPONSE_TEXT'
  | 'MALFORMED_FUNCTION_CALL'
  | 'UNEXPECTED_FINISH_REASON';

/**
 * Error thrown when the streaming response from the model is structurally
 * invalid (e.g. no finish reason, empty response, or a malformed tool call).
 *
 * This is intentionally distinct from a transport error: the bytes arrived
 * fine, but the content violates contract. Callers typically surface this as
 * a "stream invalid" event rather than a retry.
 */
export class InvalidStreamError extends Error {
  readonly reason: InvalidStreamReason;

  constructor(message: string, reason: InvalidStreamReason) {
    super(message);
    this.name = 'InvalidStreamError';
    this.reason = reason;
  }
}
