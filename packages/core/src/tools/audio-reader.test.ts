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

  it('uses the current audio-capable model before local ASR', async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: 'transcript from current audio model' }],
            role: 'model',
          },
        },
      ],
    });
    const createTemporaryChat = vi.fn().mockResolvedValue({ sendMessage });
    const localTranscriber = vi.fn().mockResolvedValue('local transcript');
    const config = createMockConfig({
      getTargetDir: () => tempDir,
    }) as any;
    config.getModel = () => 'custom:openai:gpt-4o-audio-preview@abc123';
    config.getCustomModelConfig = () => ({
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      modelId: 'gpt-4o-audio-preview',
      displayName: 'GPT-4o Audio',
      capabilities: ['audio'],
    });
    config.getOttoClient = vi.fn(() => ({ createTemporaryChat }));

    const tool = new AudioReaderTool(config, localTranscriber);

    const result = await tool.execute({ absolute_path: audioPath }, new AbortController().signal);

    expect(result.llmContent).toContain('via current model: GPT-4o Audio');
    expect(result.llmContent).toContain('transcript from current audio model');
    expect(createTemporaryChat).toHaveBeenCalledWith(
      'image_reader',
      'custom:openai:gpt-4o-audio-preview@abc123',
      { type: 'sub', agentId: 'AudioReader' },
      { disableSystemPrompt: true },
    );
    expect(localTranscriber).not.toHaveBeenCalled();
  });

  it('falls back to local ASR when the current custom model is text-only', async () => {
    const getOttoClient = vi.fn();
    const config = createMockConfig({
      getTargetDir: () => tempDir,
    }) as any;
    config.getModel = () => 'custom:openai:doubao-pro@abc123';
    config.getCustomModelConfig = () => ({
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      modelId: 'doubao-pro',
      displayName: 'Doubao Pro',
      capabilities: ['text'],
    });
    config.getOttoClient = getOttoClient;

    const tool = new AudioReaderTool(
      config,
      vi.fn().mockResolvedValue('local meeting transcript'),
    );

    const result = await tool.execute({ absolute_path: audioPath }, new AbortController().signal);

    expect(result.llmContent).toContain('via local ASR');
    expect(result.llmContent).toContain('local meeting transcript');
    expect(getOttoClient).not.toHaveBeenCalled();
  });

  it('explains local setup options when a custom text model has no local ASR', async () => {
    const config = createMockConfig({
      getTargetDir: () => tempDir,
    }) as any;
    config.getModel = () => 'custom:openai:doubao-pro@abc123';
    config.getCustomModelConfig = () => ({
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      modelId: 'doubao-pro',
      displayName: 'Doubao Pro',
      capabilities: ['text'],
    });
    config.getOttoClient = vi.fn();

    const tool = new AudioReaderTool(config, vi.fn().mockResolvedValue(null));

    const result = await tool.execute({ absolute_path: audioPath }, new AbortController().signal);

    expect(result.llmContent).toContain('Audio transcription setup is needed');
    expect(result.llmContent).toContain('Capability check');
    expect(result.llmContent).toContain('not marked as audio-capable');
    expect(result.llmContent).toContain('Install local Whisper');
    expect(result.llmContent).toContain('winget install --id Gyan.FFmpeg');
    expect(result.llmContent).toContain('OTTO_WHISPER_MODEL');
    expect(result.llmContent).not.toContain('Gemini');
    expect(config.getOttoClient).not.toHaveBeenCalled();
  });
});
