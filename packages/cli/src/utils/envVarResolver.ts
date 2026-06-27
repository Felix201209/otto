/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Recursively resolves environment variable references in an object.
 * Supports ${VAR_NAME} syntax.
 */
export function resolveEnvVarsInObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return resolveEnvVarsInString(obj);
  } else if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVarsInObject(item));
  } else if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    const record = obj as Record<string, unknown>;
    for (const key in obj) {
      result[key] = resolveEnvVarsInObject(record[key]);
    }
    return result;
  }
  return obj;
}

function resolveEnvVarsInString(str: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (match, varName) => process.env[varName] || match);
}
