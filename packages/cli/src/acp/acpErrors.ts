/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage as getCoreErrorMessage } from 'otto-core';

/**
 * Extract a human-readable error message for ACP (IDE) clients.
 *
 * API errors (Google / proxy) often come back as nested JSON blobs whose
 * useful content is buried several layers deep. This helper unpacks them
 * recursively so the message surfaced in the IDE is clean.
 */
export function getAcpErrorMessage(error: unknown): string {
  const core = getCoreErrorMessage(error);
  return extractRecursiveMessage(core);
}

function extractRecursiveMessage(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const parsed = JSON.parse(trimmed);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const next =
        parsed?.error?.message ||
        parsed?.[0]?.error?.message ||
        parsed?.message;
      if (next && typeof next === 'string' && next !== input) {
        return extractRecursiveMessage(next);
      }
    } catch {
      // fall through to original string
    }
  }
  return input;
}
