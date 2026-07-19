/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import fs from 'fs';
import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalMode } from '../config/config.js';
import { createMockConfig } from '../utils/test-helpers.js';
import { VideoEditorTool } from './video-editor.js';

const signal = () => new AbortController().signal;

describe('VideoEditorTool process safety', () => {
  it('does not use process-name matching to close unrelated apps', () => {
    const source = fs.readFileSync(new URL('./video-editor.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/pkill\s+-f/);
    expect(source).not.toMatch(/Get-Process[\s\S]*Stop-Process/);
  });

  it('requires confirmation before terminating managed editor processes', async () => {
    const tool = new VideoEditorTool(createMockConfig());

    const confirmation = await tool.shouldConfirmExecute({ action: 'close' }, signal());

    expect(confirmation).not.toBe(false);
    expect(confirmation && confirmation.type).toBe('exec');
    expect(confirmation && confirmation.title).toContain('[WARN]');
  });

  it('allows close without confirmation only in YOLO mode', async () => {
    const tool = new VideoEditorTool(createMockConfig({
      getApprovalMode: () => ApprovalMode.YOLO,
    }));

    await expect(tool.shouldConfirmExecute({ action: 'close' }, signal())).resolves.toBe(false);
  });

  it('keeps non-terminating status checks auto-approved', async () => {
    const tool = new VideoEditorTool(createMockConfig());

    await expect(tool.shouldConfirmExecute({ action: 'status' }, signal())).resolves.toBe(false);
  });

  it('close terminates only a child process previously launched by this tool', async () => {
    const tool = new VideoEditorTool(createMockConfig());
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      kill: vi.fn(),
    });
    child.kill.mockImplementation(() => {
      child.killed = true;
      child.emit('exit', 0, null);
      return true;
    });

    const internals = tool as unknown as {
      trackManagedChild(process: typeof child): void;
    };
    internals.trackManagedChild(child);

    const result = await tool.execute({ action: 'close' }, signal());

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(result.llmContent).toContain('1 managed process');
  });

  it('close leaves external processes alone when this tool launched nothing', async () => {
    const tool = new VideoEditorTool(createMockConfig());

    const result = await tool.execute({ action: 'close' }, signal());

    expect(result.llmContent).toContain('no external process was touched');
  });
});
