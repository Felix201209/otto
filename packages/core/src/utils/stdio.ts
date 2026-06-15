/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Capture the original stdout/stderr write methods once, at module load time,
// before any monkey patching (e.g. the ink renderer) replaces them.
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

/**
 * Writes to the real stdout, bypassing any monkey-patched `process.stdout.write`.
 * Use this from ACP / JSON-RPC code paths that must not be corrupted by
 * renderer output or stray `console.log` calls.
 */
export function writeToStdout(
  ...args: Parameters<typeof process.stdout.write>
): boolean {
  return originalStdoutWrite(...args);
}

/** Writes to the real stderr, bypassing any monkey-patched `process.stderr.write`. */
export function writeToStderr(
  ...args: Parameters<typeof process.stderr.write>
): boolean {
  return originalStderrWrite(...args);
}

/** Type guard so we can index a typed object by an unknown key. */
function isKey<T extends object>(
  key: string | symbol | number,
  obj: T,
): key is keyof T {
  return key in obj;
}

/**
 * Returns proxies for `process.stdout` and `process.stderr` whose `write`
 * methods always call the originally captured write functions, regardless of
 * later monkey-patching. This is the escape hatch the ACP transport uses to
 * deliver JSON-RPC frames over stdio while the rest of the process may be
 * running ink rendering or other writers.
 */
export function createWorkingStdio(): {
  stdout: typeof process.stdout;
  stderr: typeof process.stderr;
} {
  const stdoutHandler: ProxyHandler<typeof process.stdout> = {
    get(target, prop) {
      if (prop === 'write') {
        return writeToStdout;
      }
      if (isKey(prop, target)) {
        const value = target[prop];
        if (typeof value === 'function') {
          return (value as Function).bind(target);
        }
        return value;
      }
      return undefined;
    },
  };
  const stdout = new Proxy(process.stdout, stdoutHandler);

  const stderrHandler: ProxyHandler<typeof process.stderr> = {
    get(target, prop) {
      if (prop === 'write') {
        return writeToStderr;
      }
      if (isKey(prop, target)) {
        const value = target[prop];
        if (typeof value === 'function') {
          return (value as Function).bind(target);
        }
        return value;
      }
      return undefined;
    },
  };
  const stderr = new Proxy(process.stderr, stderrHandler);

  return { stdout, stderr };
}
