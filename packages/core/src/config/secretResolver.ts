/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 *
 * Secret Resolver — safely resolve API keys and other secrets from
 * environment variables or macOS Keychain without plaintext in config files.
 *
 * Supported prefixes:
 *   $ENV:VAR_NAME       → read from process.env[VAR_NAME]
 *   $KEYCHAIN:ACCT_NAME → stub: read from process.env[ACCT_NAME] as fallback
 *
 * Masking for audit logs:
 *   maskSecret('sk-abc123def456gh') → '***f456gh'
 */

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/**
 * Resolve a secret reference.
 *
 * - If `value` starts with `$ENV:`, read the named environment variable.
 * - If `value` starts with `$KEYCHAIN:`, try macOS Keychain, fall back to env.
 * - Otherwise return `value` unchanged (plain-text or already-resolved).
 *
 * Returns `undefined` if the referenced secret cannot be resolved.
 */
export function resolveSecret(value: string): string | undefined {
  if (!value) return undefined;

  // $ENV: prefix
  if (value.startsWith('$ENV:')) {
    const varName = value.slice(5);
    const resolved = process.env[varName];
    if (resolved === undefined) {
      console.warn(
        `[SecretResolver] Environment variable "${varName}" is not set.`,
      );
    }
    return resolved;
  }

  // $KEYCHAIN: prefix — stub (macOS Keychain integration TBD)
  if (value.startsWith('$KEYCHAIN:')) {
    const accountName = value.slice(10);
    // Fallback: try the same-named environment variable
    const fallback = process.env[accountName];
    if (fallback !== undefined) {
      return fallback;
    }
    console.warn(
      `[SecretResolver] Keychain entry "${accountName}" not available (Keychain stub — set env var "${accountName}" as fallback).`,
    );
    return undefined;
  }

  // Plain value — no resolution needed
  return value;
}

// ---------------------------------------------------------------------------
// Mask
// ---------------------------------------------------------------------------

/**
 * Mask a secret for safe logging/auditing.
 *
 * Shows only the last 6 characters, prefixed with `***`.
 *
 * Examples:
 *   maskSecret('sk-abc123def456gh') → '***f456gh'
 *   maskSecret('short')             → '***short'
 *   maskSecret('')                  → '***'
 */
export function maskSecret(value: string): string {
  if (!value) return '***';
  if (value.length <= 6) return '***' + value;
  return '***' + value.slice(-6);
}
