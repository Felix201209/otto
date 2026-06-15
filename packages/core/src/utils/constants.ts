/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared constants used across ACP and file-reference handling.
 */

/** Marker prepended to content that was implicitly loaded from @-path references. */
export const REFERENCE_CONTENT_START = '--- Content from referenced files ---';

/** Marker appended after reference content. */
export const REFERENCE_CONTENT_END = '--- End of content ---';

export const DEFAULT_MAX_LINES_TEXT_FILE = 2000;
export const MAX_LINE_LENGTH_TEXT_FILE = 2000;
export const MAX_FILE_SIZE_MB = 20;
