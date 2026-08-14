/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suite contains many SQLite/SQLCipher databases and enterprise HTTP
    // servers. Letting Vitest size the worker pool from a high-core host causes
    // disk, handle and module-loader contention on Windows and can turn healthy
    // tests into timeouts. Four isolated workers retain useful parallelism
    // without the 14-minute cost of a fully serial run.
    maxWorkers: 4,
    minWorkers: 1,
    // Enterprise database modules are intentionally re-imported in migration
    // and tenant-isolation tests. Coverage instrumentation on slower Windows
    // runners can make the first import exceed Vitest's 5 second default.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
