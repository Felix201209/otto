/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-local serialization for read/modify/write operations on a memory file.
 *
 * Both user initiated writes and background maintenance must use this helper;
 * otherwise a maintenance rewrite can overwrite a fact saved at the same time.
 */
const memoryFileWriteChains = new Map<string, Promise<void>>();

export async function withMemoryFileWriteLock<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = memoryFileWriteChains.get(filePath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );

  memoryFileWriteChains.set(filePath, settled);
  try {
    return await run;
  } finally {
    if (memoryFileWriteChains.get(filePath) === settled) {
      memoryFileWriteChains.delete(filePath);
    }
  }
}
