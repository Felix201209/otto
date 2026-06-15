/**
 * @license
 * Copyright 2025 Easy Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for the Otto User-Agent string.
 *
 * Format: `Otto/<client>/<version> (<platform>; <arch>)`
 *   - client:  `VSCode` when the version is prefixed with `VSCode-`
 *              (set by the VS Code extension), otherwise `CLI`.
 *   - version: the resolved version with any `VSCode-` prefix stripped.
 *
 * Examples:
 *   Otto/CLI/1.0.399 (win32; x64)
 *   Otto/VSCode/1.1.0 (darwin; arm64)
 *
 * The version is resolved from (in order):
 *   1. the explicit `version` argument, if provided;
 *   2. the `CLI_VERSION` environment variable (set by the CLI entrypoint and
 *      by the VS Code extension as `VSCode-<extensionVersion>`);
 *   3. the literal `unknown`.
 */
export const USER_AGENT_BRAND = 'Otto';

export function getUserAgent(version?: string): string {
  const resolved = version ?? process.env.CLI_VERSION ?? 'unknown';
  const platform = process.platform;
  const arch = process.arch;

  // The VS Code extension sets CLI_VERSION as `VSCode-<extensionVersion>`.
  if (resolved.startsWith('VSCode-')) {
    const actualVersion = resolved.slice('VSCode-'.length) || 'unknown';
    return `${USER_AGENT_BRAND}/VSCode/${actualVersion} (${platform}; ${arch})`;
  }

  return `${USER_AGENT_BRAND}/CLI/${resolved} (${platform}; ${arch})`;
}
