/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it, vi, beforeEach } from 'vitest';
import { ShellTool, isServerOrPersistentCommand } from './shell.js';
import { Config } from '../config/config.js';
import * as summarizer from '../utils/summarizer.js';
import { GeminiClient } from '../core/client.js';
import { ToolExecuteConfirmationDetails } from './tools.js';
import os from 'os';

describe('ShellTool Bug Reproduction', () => {
  let shellTool: ShellTool;
  let config: Config;

  beforeEach(() => {
    config = {
      getCoreTools: () => undefined,
      getExcludeTools: () => undefined,
      getDebugMode: () => false,
      getGeminiClient: () => ({}) as GeminiClient,
      getTargetDir: () => '.',
      getSummarizeToolOutputConfig: () => ({
        [shellTool.name]: {},
      }),
    } as unknown as Config;
    shellTool = new ShellTool(config);
  });

  it('should not let the summarizer override the return display', async () => {
    const summarizeSpy = vi
      .spyOn(summarizer, 'summarizeToolOutput')
      .mockResolvedValue('summarized output');

    const abortSignal = new AbortController().signal;
    const result = await shellTool.execute(
      { command: 'echo hello' },
      abortSignal,
      () => {},
    );

    expect(typeof result.returnDisplay === 'string' ? result.returnDisplay.trim() : result.returnDisplay).toBe('hello');
    expect(result.llmContent).toBe('summarized output');
    expect(summarizeSpy).toHaveBeenCalled();
  });

  it('should not call summarizer if disabled in config', async () => {
    config = {
      getCoreTools: () => undefined,
      getExcludeTools: () => undefined,
      getDebugMode: () => false,
      getGeminiClient: () => ({}) as GeminiClient,
      getTargetDir: () => '.',
      getSummarizeToolOutputConfig: () => ({}),
    } as unknown as Config;
    shellTool = new ShellTool(config);

    const summarizeSpy = vi
      .spyOn(summarizer, 'summarizeToolOutput')
      .mockResolvedValue('summarized output');

    const abortSignal = new AbortController().signal;
    const result = await shellTool.execute(
      { command: 'echo hello' },
      abortSignal,
      () => {},
    );

    expect(typeof result.returnDisplay === 'string' ? result.returnDisplay.trim() : result.returnDisplay).toBe('hello');
    expect(result.llmContent).not.toBe('summarized output');
    expect(summarizeSpy).not.toHaveBeenCalled();
  });

  it('should pass token budget to summarizer', async () => {
    config = {
      getCoreTools: () => undefined,
      getExcludeTools: () => undefined,
      getDebugMode: () => false,
      getGeminiClient: () => ({}) as GeminiClient,
      getTargetDir: () => '.',
      getSummarizeToolOutputConfig: () => ({
        [shellTool.name]: { tokenBudget: 1000 },
      }),
    } as unknown as Config;
    shellTool = new ShellTool(config);

    const summarizeSpy = vi
      .spyOn(summarizer, 'summarizeToolOutput')
      .mockResolvedValue('summarized output');

    const abortSignal = new AbortController().signal;
    await shellTool.execute({ command: 'echo "hello"' }, abortSignal, () => {});

    expect(summarizeSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      1000,
    );
  });

  it('should use default token budget if not specified', async () => {
    config = {
      getCoreTools: () => undefined,
      getExcludeTools: () => undefined,
      getDebugMode: () => false,
      getGeminiClient: () => ({}) as GeminiClient,
      getTargetDir: () => '.',
      getSummarizeToolOutputConfig: () => ({
        [shellTool.name]: {},
      }),
    } as unknown as Config;
    shellTool = new ShellTool(config);

    const summarizeSpy = vi
      .spyOn(summarizer, 'summarizeToolOutput')
      .mockResolvedValue('summarized output');

    const abortSignal = new AbortController().signal;
    await shellTool.execute({ command: 'echo "hello"' }, abortSignal, () => {});

    expect(summarizeSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      undefined,
    );
  });

  it('should pass GEMINI_CLI environment variable to executed commands', async () => {
    config = {
      getCoreTools: () => undefined,
      getExcludeTools: () => undefined,
      getDebugMode: () => false,
      getGeminiClient: () => ({}) as GeminiClient,
      getTargetDir: () => '.',
      getSummarizeToolOutputConfig: () => ({}),
    } as unknown as Config;
    shellTool = new ShellTool(config);

    const abortSignal = new AbortController().signal;
    const command =
      os.platform() === 'win32' ? 'echo %GEMINI_CLI%' : 'echo "$GEMINI_CLI"';
    const result = await shellTool.execute({ command }, abortSignal, () => {});

    expect(typeof result.returnDisplay === 'string' ? result.returnDisplay.trim() : result.returnDisplay).toBe('1');
  });
});

describe('shouldConfirmExecute', () => {
  it('should de-duplicate command roots before asking for confirmation', async () => {
    const shellTool = new ShellTool({
      getCoreTools: () => ['run_shell_command'],
      getExcludeTools: () => [],
    } as unknown as Config);
    const result = (await shellTool.shouldConfirmExecute(
      {
        command: 'git status && git log',
      },
      new AbortController().signal,
    )) as ToolExecuteConfirmationDetails;
    expect(result.rootCommand).toEqual('git');
  });
});

describe('isServerOrPersistentCommand', () => {
  it('identifies server and persistent commands correctly', () => {
    // 1. Matches
    expect(isServerOrPersistentCommand('npm run dev')).toBe(true);
    expect(isServerOrPersistentCommand('npm start')).toBe(true);
    expect(isServerOrPersistentCommand('pnpm dev')).toBe(true);
    expect(isServerOrPersistentCommand('vite')).toBe(true);
    expect(isServerOrPersistentCommand('python -m http.server')).toBe(true);
    expect(isServerOrPersistentCommand('uvicorn main:app')).toBe(true);
    expect(isServerOrPersistentCommand('flask run')).toBe(true);
    expect(isServerOrPersistentCommand('python manage.py runserver')).toBe(true);
    expect(isServerOrPersistentCommand('rails server')).toBe(true);
    expect(isServerOrPersistentCommand('php -S localhost:8000')).toBe(true);
    expect(isServerOrPersistentCommand('docker compose up')).toBe(true);

    // 2. Non-matches
    expect(isServerOrPersistentCommand('npm run test')).toBe(false);
    expect(isServerOrPersistentCommand('python test.py')).toBe(false);
    expect(isServerOrPersistentCommand('git status')).toBe(false);
    expect(isServerOrPersistentCommand('echo hello')).toBe(false);
    expect(isServerOrPersistentCommand('docker compose up -d')).toBe(false);
  });
});

describe('ShellTool - Background Task Actions', () => {
  let shellTool: ShellTool;
  let config: Config;

  beforeEach(() => {
    config = {
      getCoreTools: () => undefined,
      getExcludeTools: () => undefined,
      getDebugMode: () => false,
      getGeminiClient: () => ({}) as GeminiClient,
      getTargetDir: () => '.',
      getSummarizeToolOutputConfig: () => ({}),
    } as unknown as Config;
    shellTool = new ShellTool(config);
  });

  it('validates action parameters correctly', () => {
    // normal execute needs command
    expect(shellTool.validateToolParams({ command: '' })).not.toBeNull();
    expect(shellTool.validateToolParams({ command: 'echo 1' })).toBeNull();

    // list_background_tasks needs no command
    expect(shellTool.validateToolParams({ command: '', action: 'list_background_tasks' })).toBeNull();

    // stop_background_task needs backgroundTaskId
    expect(shellTool.validateToolParams({ command: '', action: 'stop_background_task' })).not.toBeNull();
    expect(shellTool.validateToolParams({ command: '', action: 'stop_background_task', backgroundTaskId: '123' })).toBeNull();
  });

  it('bypasses confirmation for background task listings/stop', async () => {
    const signal = new AbortController().signal;
    const confirmList = await shellTool.shouldConfirmExecute({ command: '', action: 'list_background_tasks' }, signal);
    expect(confirmList).toBe(false);

    const confirmStop = await shellTool.shouldConfirmExecute({ command: '', action: 'stop_background_task', backgroundTaskId: 'abc' }, signal);
    expect(confirmStop).toBe(false);
  });
});