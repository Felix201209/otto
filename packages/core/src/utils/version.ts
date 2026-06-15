/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Resolve an absolute path for this module. Under ESM we use
 * `import.meta.url`; when the module is transpiled to CommonJS (for example
 * when the VS Code extension bundles core into its `extension.bundle.js`),
 * `import.meta` is stripped away, so we fall back to `__dirname` — which
 * CommonJS provides as a global.
 */
function getThisDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (globalThis as any)['import']?.['meta'] ?? undefined;
  // In ESM, import.meta.url is a statically-resolved property on the module;
  // reading it through the global pathway above is intentionally defensive
  // for environments where a bundler strips it. If it fails, fall back.
  try {
    // @ts-ignore — import.meta is valid in our source, but may be rewritten.
    const url = (typeof import.meta !== 'undefined' ? import.meta.url : undefined) as
      | string
      | undefined;
    if (url) return path.dirname(fileURLToPath(url));
  } catch {
    // swallow and try the CJS fallback
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cjsDir = (globalThis as any)['__dirname'] as string | undefined;
  if (typeof cjsDir === 'string') return cjsDir;
  return process.cwd();
}

let versionPromise: Promise<string> | undefined;

/**
 * Resolves to the CLI version string. Prefers the `CLI_VERSION` env var, then
 * falls back to the nearest ancestor `package.json#version`, then finally
 * `'unknown'`.
 *
 * Result is cached for the process lifetime.
 */
export function getVersion(): Promise<string> {
  if (versionPromise) {
    return versionPromise;
  }
  versionPromise = (async () => {
    if (process.env['CLI_VERSION']) {
      return process.env['CLI_VERSION'];
    }
    // Walk upward from this file looking for a package.json.
    let dir = getThisDir();
    for (let i = 0; i < 10; i++) {
      try {
        const pkgRaw = await readFile(
          path.join(dir, 'package.json'),
          'utf8',
        );
        const pkg = JSON.parse(pkgRaw) as { version?: string };
        if (typeof pkg.version === 'string' && pkg.version.length > 0) {
          return pkg.version;
        }
      } catch {
        // ignore and keep walking
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return 'unknown';
  })();
  return versionPromise;
}

/** For testing purposes only. */
export function resetVersionCache(): void {
  versionPromise = undefined;
}
