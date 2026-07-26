/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure provider-adapter contract values shared by custom model transports.
 * Keep HTTP calls, schema conversion, auth loading, and response mapping out of
 * this module so kernel code can depend on contracts without importing provider
 * implementation details.
 */

export const CUSTOM_MODEL_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export const CUSTOM_MODEL_STREAM_READ_IDLE_TIMEOUT_MS = 300000;

export const CODEX_OAUTH_SENTINEL = '${CODEX_OAUTH}';
