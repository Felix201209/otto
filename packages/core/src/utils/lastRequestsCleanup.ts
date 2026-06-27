/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Periodic cleanup of `~/.otto/last-requests/`.
 *
 * The directory is a debugging ring-buffer where both OttoServerAdapter
 * (proxy-mode requests) and customModelAdapter (Gemini native requests) drop
 * a JSON copy of every outbound body. Each writer trims its OWN files via
 * a small ring (5–N entries), but:
 *   - Old machine state from a previous version that wrote with different
 *     filename patterns can linger forever.
 *   - Across many days the per-pattern rings still accumulate dozens of MB
 *     in the worst case (large request bodies).
 *
 * To bound disk usage we run a single age-based sweep at process startup:
 * delete any *.json older than RETENTION_DAYS (default 3).
 *
 * Design choices:
 *   - **Once per process**: a module-level flag guarantees the sweep runs
 *     once, even if multiple Config instances initialize (mirrors the
 *     `isMCPDiscoveryTriggered()` pattern). Cheap, safe.
 *   - **Async, fire-and-forget**: never blocks Config.initialize() — disk
 *     IO failures must not break startup.
 *   - **Conservative**: we ONLY touch `*.json` (and `*.tmp` leftovers from
 *     interrupted atomic writes) inside the well-known dump directory; if
 *     the directory doesn't exist we silently no-op.
 *   - **Test-safe**: skipped under `vitest` so the sweep never deletes
 *     diagnostic dumps a developer is currently inspecting.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const RETENTION_DAYS = 3;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

let alreadyRan = false;

export function getLastRequestsDir(): string {
  return path.join(os.homedir(), '.otto-user', 'last-requests');
}

/**
 * Run the age-based sweep. Idempotent within a single process — the second
 * call is a no-op.
 *
 * @param now  Optional clock injection for tests; defaults to `Date.now()`.
 * @param retentionMs  Optional retention window override; defaults to 3 days.
 * @returns  Number of files deleted (0 if dir missing or sweep skipped).
 */
export async function cleanupLastRequestsDir(
  now: number = Date.now(),
  retentionMs: number = RETENTION_MS,
): Promise<number> {
  if (alreadyRan) return 0;
  alreadyRan = true;

  // Don't trash a developer's dumps under vitest.
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return 0;

  const dir = getLastRequestsDir();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (err) {
    // ENOENT is expected the very first time anyone runs Otto.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      // Any other error is non-fatal — just don't sweep this run.
    }
    return 0;
  }

  let deleted = 0;
  await Promise.all(
    entries.map(async (name) => {
      // Only touch files we authored (json + their .tmp transients).
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) return;
      const file = path.join(dir, name);
      try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile()) return;
        // Use mtime so user-edited files (rare) are also subject to the rule.
        if (now - stat.mtimeMs > retentionMs) {
          await fs.promises.unlink(file);
          deleted++;
        }
      } catch {
        // best-effort
      }
    }),
  );

  return deleted;
}

/**
 * Reset the once-per-process latch. Test-only.
 */
export function _resetLastRequestsCleanupLatch(): void {
  alreadyRan = false;
}
