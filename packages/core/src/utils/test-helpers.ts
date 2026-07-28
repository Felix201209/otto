/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Test helpers for Otto tool unit tests.
 * Provides a shared mock Config factory to eliminate boilerplate.
 *
 * Usage:
 *   import { createMockConfig } from '../utils/test-helpers.js';
 *   const config = createMockConfig({ getTargetDir: () => '/tmp/test' });
 */

import { vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  ApprovalMode,
  type DocumentIdentity,
} from '../config/config.js';

export interface MockConfigOverrides {
  getTargetDir?: () => string;
  getApprovalMode?: () => ApprovalMode;
  setApprovalMode?: (mode: ApprovalMode) => void;
  getDocumentIdentity?: () => DocumentIdentity | undefined;
}

/**
 * Create a mock Config instance for tool testing.
 * All methods return sensible defaults; override via `overrides`.
 */
export function createMockConfig(overrides?: MockConfigOverrides): Config {
  const defaults = {
    getTargetDir: () => process.cwd(),
    getApprovalMode: vi.fn(() => ApprovalMode.DEFAULT),
    setApprovalMode: vi.fn(),
    getDocumentIdentity: vi.fn(() => undefined),
  };

  return { ...defaults, ...overrides } as unknown as Config;
}

/**
 * Mock child_process.exec to return controlled stdout/stderr.
 *
 * Usage:
 *   const mockExec = mockChildProcess({ stdout: 'output', stderr: '' });
 *   // tool calls execAsync -> receives mockExec
 */
export function mockExecResult(output: { stdout: string; stderr?: string }) {
  const exec = vi.fn(
    (_cmd: string, _opts?: any, _cb?: any) => {
      const callback = typeof _opts === 'function' ? _opts : _cb;
      if (callback) {
        callback(null, output, '');
      }
      const child = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        stdin: { write: vi.fn(), end: vi.fn() },
      };
      // Hack: promisify(exec) returns the child via callback
      return child;
    }
  );
  return exec;
}

/**
 * Simple helper to run the tool and assert basic success format.
 */
export function assertToolSuccess(result: { llmContent: string; returnDisplay: string }, toolName: string) {
  if (result.llmContent.includes('FAIL') || result.returnDisplay.includes('FAIL')) {
    throw new Error(`Expected success but got failure: ${result.llmContent}`);
  }
}
