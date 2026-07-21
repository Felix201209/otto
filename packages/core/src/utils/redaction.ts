/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * Removes common credentials from logs, diagnostics and automatically captured
 * work summaries. This intentionally favors false positives over leaking a
 * token: these surfaces are for troubleshooting, not exact request replay.
 */
export function redactSensitiveText(input: string): string {
  return String(input ?? '')
    .replace(
      /\b(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi,
      '$1[REDACTED]@',
    )
    .replace(
      /("(?:apiKey|api_key|appSecret|app_secret|accessToken|access_token|refreshToken|refresh_token|token|password|secret|authorization)"\s*:\s*")([\s\S]*?)(")/gi,
      '$1[REDACTED]$3',
    )
    .replace(
      /((?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*)(?:Bearer\s+)?([^\s,;&]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(\bAuthorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)=)[^&#\s]*/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(?:sk|ark|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g,
      '[REDACTED]',
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g,
      '[REDACTED]',
    );
}
