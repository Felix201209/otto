/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { DiagnoseSystemTool } from './diagnose-system.js';
import { createMockConfig } from '../utils/test-helpers.js';

describe('DiagnoseSystemTool', () => {
  let tool: DiagnoseSystemTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new DiagnoseSystemTool(createMockConfig());
  });

  // --- Metadata ---
  it('has correct static name', () => {
    expect(DiagnoseSystemTool.Name).toBe('diagnose_system');
  });
  it('has correct display name', () => {
    expect(tool.displayName).toBe('DiagnoseSystem');
  });
  it('has icon Wrench', () => {
    expect(tool.icon).toBe('wrench');
  });
  it('schema requires action', () => {
    expect(tool.schema.parameters?.required).toContain('action');
  });

  // --- Validation ---
  it('validateToolParams returns null for valid action', () => {
    expect(tool.validateToolParams({ action: 'system_info' })).toBeNull();
  });
  it('validateToolParams returns null for all 13 actions', () => {
    const actions = ['system_info','disk_health','disk_usage','memory','network','processes','cleanup','battery','startup','bluetooth','printer','brew_doctor','repair_permissions'];
    for (const a of actions) {
      expect(tool.validateToolParams({ action: a as unknown as Parameters<typeof tool.validateToolParams>[0]['action'] })).toBeNull();
    }
  });

  // --- getDescription ---
  it('getDescription includes action name', () => {
    expect(tool.getDescription({ action: 'disk_health' })).toContain('disk_health');
  });

  // --- shouldConfirmExecute ---
  it('shouldConfirmExecute returns false for read-only actions', async () => {
    const result = await tool.shouldConfirmExecute({ action: 'system_info' }, new AbortController().signal);
    expect(result).toBe(false);
  });
  it('shouldConfirmExecute requires confirmation for repair_permissions', async () => {
    const result = await tool.shouldConfirmExecute({ action: 'repair_permissions' }, new AbortController().signal);
    expect(result).not.toBe(false);
    if (result && typeof result === 'object') {
      expect(result.type).toBe('exec');
    }
  });

  // --- execute: integration tests (mock exec) ---
  describe('execute with mocked exec', () => {
    beforeEach(() => {
      vi.mock('child_process', () => ({
          exec: vi.fn((_cmd: string, _opts: unknown) => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.pid = 99999;
            setImmediate(() => {
              child.stdout.emit('data', Buffer.from('mock output'));
              child.emit('close', 0, null);
            });
            return child;
          }),
          execFile: vi.fn((_file: string, _args: string[], _opts: unknown, cb: (error: Error | null, stdout?: string, stderr?: string) => void) => {
            setImmediate(() => cb(null, 'mock output', ''));
          }),
      }));
    });

    it('execute system_info returns OK', async () => {
      const result = await tool.execute({ action: 'system_info' });
      expect(result.returnDisplay).toContain('diagnose_system OK');
      expect(result.llmContent).toContain('System Info');
    });

    it('execute disk_health returns OK', async () => {
      const result = await tool.execute({ action: 'disk_health' });
      expect(result.returnDisplay).toContain('diagnose_system OK');
    });

    it('execute memory returns OK', async () => {
      const result = await tool.execute({ action: 'memory' });
      expect(result.returnDisplay).toContain('diagnose_system OK');
    });

    it('execute network returns OK', async () => {
      const result = await tool.execute({ action: 'network' });
      expect(result.returnDisplay).toContain('diagnose_system OK');
    });

    it('execute processes returns OK', async () => {
      const result = await tool.execute({ action: 'processes' });
      expect(result.returnDisplay).toContain('diagnose_system OK');
    });

    it('execute cleanup returns OK', async () => {
      const result = await tool.execute({ action: 'cleanup' });
      expect(result.returnDisplay).toContain('diagnose_system OK');
    });

    it('execute battery returns OK', async () => {
      const result = await tool.execute({ action: 'battery' });
      expect(result.returnDisplay).toContain('diagnose_system OK');
    });
  });
});
