/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioReaderTool } from './audio-reader.js';
import { createMockConfig } from '../utils/test-helpers.js';

describe('AudioReaderTool', () => {
  let tempDir: string;
  let audioPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-audio-reader-'));
    audioPath = path.join(tempDir, 'meeting.wav');
    fs.writeFileSync(audioPath, Buffer.from('RIFF----WAVEfmt '));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses local ASR before creating a Gemini fallback chat', async () => {
    const getOttoClient = vi.fn();
    const config = createMockConfig({
      getTargetDir: () => tempDir,
    }) as any;
    config.getOttoClient = getOttoClient;

    const tool = new AudioReaderTool(
      config,
      vi.fn().mockResolvedValue('本地转写出来的会议内容'),
    );

    const result = await tool.execute({ absolute_path: audioPath }, new AbortController().signal);

    expect(result.llmContent).toContain('via local ASR');
    expect(result.llmContent).toContain('本地转写出来的会议内容');
    expect(getOttoClient).not.toHaveBeenCalled();
  });

  it('explains setup options when a custom text model has no local ASR or Gemini fallback', async () => {
    const config = createMockConfig({
      getTargetDir: () => tempDir,
    }) as any;
    config.getModel = () => 'custom:openai:doubao-pro@abc123';
    config.getCustomModels = () => [
      {
        enabled: true,
        modelId: 'doubao-pro',
        displayName: 'Doubao Pro',
      },
    ];
    config.getOttoClient = vi.fn();

    const tool = new AudioReaderTool(config, vi.fn().mockResolvedValue(null));

    const result = await tool.execute({ absolute_path: audioPath }, new AbortController().signal);

    expect(result.llmContent).toContain('Audio transcription is not configured');
    expect(result.llmContent).toContain('Install local Whisper');
    expect(result.llmContent).toContain('OPENAI_API_KEY or ARK_API_KEY');
    expect(config.getOttoClient).not.toHaveBeenCalled();
  });
});
