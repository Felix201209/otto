import fs, { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Part } from '@google/genai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Config } from '../config/config.js';
import type { ContentGenerator } from '../core/contentGenerator.js';
import { MCPResponseGuard } from './mcpResponseGuard.js';

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const testDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'otto-mcp-response-guard-'));
  testDirectories.push(directory);
  return directory;
}

function config(): Config {
  return {
    getModel: () => 'auto',
    getCloudModelInfo: () => undefined,
  } as unknown as Config;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of testDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('MCPResponseGuard cleanup lifecycle', () => {
  it('starts one unreferenced timer lazily and stops it after the last file expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'));
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const guard = new MCPResponseGuard({
      maxResponseSize: 1,
      tempDir: createTempDirectory(),
      tempFileTTL: 1_000,
    });

    expect(setIntervalSpy).not.toHaveBeenCalled();
    const first = await guard.guardResponse(
      [{ text: 'first oversized MCP response' }] as Part[],
      config(),
      'mcp.test',
    );
    vi.setSystemTime(new Date('2026-08-22T00:00:00.001Z'));
    const second = await guard.guardResponse(
      [{ text: 'second oversized MCP response' }] as Part[],
      config(),
      'mcp.test',
    );

    expect(first.wasStoredAsFile).toBe(true);
    expect(second.wasStoredAsFile).toBe(true);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(guard.getTempFiles()).toHaveLength(2);
    const storedFiles = guard.getTempFiles();
    expect(storedFiles.every((file) => existsSync(file))).toBe(true);

    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS);

    expect(guard.getTempFiles()).toEqual([]);
    expect(storedFiles.every((file) => !existsSync(file))).toBe(true);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    await guard.dispose();
  });

  it('waits for an in-flight guard operation, cleans its file, and is idempotent', async () => {
    let resolveTokens!: (value: { totalTokens: number }) => void;
    const tokenResult = new Promise<{ totalTokens: number }>((resolve) => {
      resolveTokens = resolve;
    });
    const countTokens = vi.fn(() => tokenResult);
    const contentGenerator = { countTokens } as unknown as ContentGenerator;
    const guard = new MCPResponseGuard({
      maxResponseSize: 1,
      tempDir: createTempDirectory(),
    });
    const parts = [{ text: 'oversized response while disposal begins' }] as Part[];

    const operation = guard.guardResponse(parts, config(), 'mcp.concurrent', 50, contentGenerator);
    expect(countTokens).toHaveBeenCalledOnce();
    const firstDispose = guard.dispose();
    const secondDispose = guard.dispose();
    expect(secondDispose).toBe(firstDispose);
    let disposed = false;
    void firstDispose.then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);

    resolveTokens({ totalTokens: 1 });
    const result = await operation;
    expect(result.wasStoredAsFile).toBe(true);
    await firstDispose;

    expect(disposed).toBe(true);
    expect(guard.getTempFiles()).toEqual([]);
    expect(result.tempFilePath && existsSync(result.tempFilePath)).toBe(false);
    await expect(guard.guardResponse(parts, config(), 'mcp.after-dispose'))
      .rejects.toThrow('MCPResponseGuard has been disposed');
  });
  it('retains a locked file and retries its deletion with backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'));
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const guard = new MCPResponseGuard({
      maxResponseSize: 1,
      tempDir: createTempDirectory(),
      tempFileTTL: 1_000,
    });

    const result = await guard.guardResponse(
      [{ text: 'response whose temp file cannot be deleted' }] as Part[],
      config(),
      'mcp.unlink-failure',
    );
    const storedFile = result.tempFilePath!;
    expect(existsSync(storedFile)).toBe(true);

    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('locked'); });
    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS);

    expect(guard.getTempFiles()).toEqual([storedFile]);
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    expect(existsSync(storedFile)).toBe(true);

    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS);

    expect(guard.getTempFiles()).toEqual([]);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(existsSync(storedFile)).toBe(false);
    await guard.dispose();
  });

  it('removes only expired managed orphan files discovered at startup', () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-22T00:30:00.000Z');
    vi.setSystemTime(now);
    const directory = createTempDirectory();
    const orphanTimestamp = now.getTime() - 60_001;
    const orphan = join(directory, `mcp-response-crashed-tool-${orphanTimestamp}.json`);
    const unrelated = join(directory, 'customer-data.json');
    fs.writeFileSync(orphan, '{"orphan":true}', 'utf8');
    fs.writeFileSync(unrelated, '{"keep":true}', 'utf8');

    const guard = new MCPResponseGuard({
      tempDir: directory,
      tempFileTTL: 60_000,
    });

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(guard.getTempFiles()).toEqual([]);
  });

  it('keeps a startup orphan tracked when its first deletion attempt fails', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-08-22T00:30:00.000Z');
    vi.setSystemTime(now);
    const directory = createTempDirectory();
    const orphanTimestamp = now.getTime() - 60_001;
    const orphan = join(directory, `mcp-response-crashed-tool-${orphanTimestamp}.txt`);
    fs.writeFileSync(orphan, 'orphan', 'utf8');
    vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => { throw new Error('locked'); });

    const guard = new MCPResponseGuard({
      tempDir: directory,
      tempFileTTL: 60_000,
    });

    expect(guard.getTempFiles()).toEqual([orphan]);
    expect(existsSync(orphan)).toBe(true);

    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS);

    expect(guard.getTempFiles()).toEqual([]);
    expect(existsSync(orphan)).toBe(false);
    await guard.dispose();
  });
});
