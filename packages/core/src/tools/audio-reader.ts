/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import fs from 'fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Type } from '@google/genai';
import mime from 'mime-types';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config } from '../config/config.js';
import {
  isWithinRoot,
  processSingleFileContent,
  detectFileType,
} from '../utils/fileUtils.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { getResponseText } from '../utils/generateContentResponseUtilities.js';
import { SceneType } from '../core/sceneManager.js';
import { getErrorMessage } from '../utils/errors.js';
import { isCustomModel, type CustomModelConfig } from '../types/customModel.js';

const execFileAsync = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parameters for the AudioReader tool
 */
export interface AudioReaderToolParams {
  /**
   * The absolute path to the audio file to read.
   */
  absolute_path: string;

  /**
   * Optional custom instruction. If omitted, the tool asks the transcription model
   * for a detailed, verbatim transcription of everything spoken in the audio.
   */
  prompt?: string;

  /**
   * Allow reading audio files outside the workspace directory.
   */
  allow_external_access?: boolean;
}

const DEFAULT_TRANSCRIBE_PROMPT =
  'Please transcribe this audio recording in extreme detail. Transcribe everything spoken verbatim, in the language it was spoken, preserving any natural pauses, emotions, or tones if relevant. Output plain prose; do not refuse.';

// Cap on the transcript length to prevent token explosion when feeding back
// into the host model.
const MAX_TRANSCRIPT_LENGTH = 15000;

function truncateTranscript(transcript: string): { transcript: string; truncated: boolean } {
  if (transcript.length <= MAX_TRANSCRIPT_LENGTH) {
    return { transcript, truncated: false };
  }
  const originalLength = transcript.length;
  return {
    transcript:
      transcript.substring(0, MAX_TRANSCRIPT_LENGTH) +
      `\n\n[Note: Transcript truncated from ${originalLength} to ${MAX_TRANSCRIPT_LENGTH} characters to prevent context overflow]`,
    truncated: true,
  };
}

/**
 * AudioReader Tool
 *
 * Used when the active model needs help turning local audio into text.
 *
 * The tool first tries the user's current audio-capable model, then Otto's
 * local/user-owned ASR bridge.
 */
export class AudioReaderTool extends BaseTool<AudioReaderToolParams, ToolResult> {
  static readonly Name: string = 'audio_reader';

  constructor(
    private readonly config: Config,
    private readonly localTranscriber: (filePath: string) => Promise<string | null> = transcribeWithLocalBridge,
  ) {
    super(
      AudioReaderTool.Name,
      'AudioReader',
      'Fallback tool for text-only models that cannot natively process audio. ' +
        'It first tries the current model when it supports audio, then Otto local transcription ' +
        '(local Whisper / user cloud ASR env). ' +
        'Do NOT call this tool proactively: ' +
        'only use it when you need to transcribe or understand audio content that ' +
        'cannot be natively processed by your current model. ' +
        'Supports MP3 / WAV / OGG / OPUS / M4A / FLAC / AAC.',
      Icon.FileSearch,
      {
        type: Type.OBJECT,
        properties: {
          absolute_path: {
            type: Type.STRING,
            description:
              'Absolute path to the audio file on disk (e.g. ' +
              '/home/user/voice.opus or C:\\\\Users\\\\me\\\\voice.mp3). ' +
              'Relative paths are not supported.',
          },
          prompt: {
            type: Type.STRING,
            description:
              'Optional custom instruction for the transcription model. If omitted, ' +
              'the tool asks for a verbatim transcription. Use this when you need ' +
              'targeted info, e.g. "Summarize the key points in this audio" or ' +
              '"Is there any background noise or music?".',
          },
          allow_external_access: {
            type: Type.BOOLEAN,
            description:
              'Optional: Allow reading audio files outside the workspace directory. ' +
              'Defaults to false. Set to true only when the user explicitly ' +
              'provides an external audio path.',
          },
        },
        required: ['absolute_path'],
      },
    );
  }

  override validateToolParams(params: AudioReaderToolParams): string | null {
    if (params && typeof params.absolute_path === 'string') {
      let cleaned = params.absolute_path.trim();
      if (
        (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))
      ) {
        cleaned = cleaned.slice(1, -1).trim();
      }
      params.absolute_path = cleaned;
    }

    const errors = SchemaValidator.validate(
      this.schema.parameters,
      params,
      AudioReaderTool.Name,
    );
    if (errors) {
      return errors;
    }

    const filePath = params.absolute_path;

    // Security check: ensure path is within root unless external access allowed
    const effectiveAllowLocalExecution = params.allow_external_access || false;
    if (!effectiveAllowLocalExecution) {
      if (!isWithinRoot(filePath, this.config.getTargetDir())) {
        return (
          `Error: Security check failed. The file path "${filePath}" is outside ` +
          `the workspace directory "${this.config.getTargetDir()}". ` +
          `To access files outside workspace, set allow_external_access=true.`
        );
      }
    }

    return null;
  }

  async execute(
    params: AudioReaderToolParams,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: validationError,
        returnDisplay: validationError,
      };
    }

    const filePath = params.absolute_path;

    // Verify it's an audio file by content (mime-type) before doing anything expensive
    let detectedType: Awaited<ReturnType<typeof detectFileType>>;
    try {
      detectedType = await detectFileType(filePath);
    } catch (e) {
      const msg = getErrorMessage(e);
      return {
        llmContent: `Error: failed to detect file type for "${filePath}": ${msg}`,
        returnDisplay: `Error: failed to detect file type: ${msg}`,
      };
    }
    if (detectedType !== 'audio') {
      return {
        llmContent:
          `Error: file at "${filePath}" is not an audio file (detected type: ${detectedType}). ` +
          `Use the read_file tool for text content.`,
        returnDisplay: `Not an audio file (detected: ${detectedType})`,
      };
    }

    const relative = makeRelative(filePath, this.config.getTargetDir());
    const currentModel = typeof this.config.getModel === 'function' ? this.config.getModel() : undefined;
    const currentModelPlan = getCurrentAudioModelPlan(this.config, currentModel);
    let modelError: string | undefined;

    if (currentModelPlan) {
      // Read and convert to base64 only when the current model can consume audio.
      let base64Data: string;
      let mimeType: string;
      try {
        const buffer = await fs.promises.readFile(filePath);
        base64Data = buffer.toString('base64');
        mimeType = mime.lookup(filePath) || 'application/octet-stream';
      } catch (e) {
        const msg = getErrorMessage(e);
        return {
          llmContent: `Error reading audio file: ${msg}`,
          returnDisplay: `Error reading audio: ${msg}`,
        };
      }

      const userPrompt =
        (params.prompt && params.prompt.trim()) || DEFAULT_TRANSCRIBE_PROMPT;

      const messageParts = [
        { text: userPrompt },
        {
          inlineData: {
            mimeType,
            data: base64Data,
          },
        },
      ];

      const currentResult = await this.transcribeWithTemporaryChat(
        messageParts,
        signal,
        currentModelPlan.model,
      );
      if (currentResult.transcript) {
        return formatTranscriptResult(
          currentResult.transcript,
          relative,
          `current model: ${currentModelPlan.label}`,
        );
      }
      modelError = currentResult.error;
    }

    const localTranscript = await this.localTranscriber(filePath);
    if (localTranscript) {
      return formatTranscriptResult(localTranscript, relative, 'local ASR');
    }

    const currentModelNote = currentModelPlan
      ? `Otto first tried the current audio-capable model, but it failed: ${modelError || 'unknown error'}.\n`
      : `Otto checked the current model, but it is not marked as audio-capable.\n`;
    return {
      llmContent:
        `Audio transcription setup is needed.\n\n` +
        `Capability check:\n` +
        `- Current model audio support: ${currentModelPlan ? 'available but failed' : 'not available'}\n` +
        `- Local speech-to-text: unavailable or returned no text\n\n` +
        currentModelNote +
        `Otto also tried local ASR, but no local/user-owned transcriber returned text. ` +
        `This audio file cannot be transcribed automatically without an audio-capable current model or local ASR.\n\n` +
        `How to fix:\n` +
        `1. Install local Whisper: pip install -U openai-whisper\n` +
        `2. Install ffmpeg so Whisper can decode common audio formats\n` +
        `   - Windows: winget install --id Gyan.FFmpeg\n` +
        `   - macOS: brew install ffmpeg\n` +
        `   - Linux: sudo apt-get install -y ffmpeg\n` +
        `3. Optional quality/performance setting: OTTO_WHISPER_MODEL=small, medium, or large-v3\n` +
        `4. Restart Otto or the terminal, then try the audio again.\n\n` +
        `If you already have a transcript, paste it directly and Otto can summarize the meeting notes now.`,
      returnDisplay: `Audio transcription setup needed`,
    };
  }

  private async transcribeWithTemporaryChat(
    messageParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
    signal: AbortSignal,
    model?: string,
  ): Promise<{ transcript: string | null; error?: string }> {
    try {
      const ottoClient = this.config.getOttoClient();
      const temporaryChat = await ottoClient.createTemporaryChat(
        SceneType.IMAGE_READER,
        model,
        { type: 'sub', agentId: 'AudioReader' },
        { disableSystemPrompt: true },
      );

      const response = await temporaryChat.sendMessage(
        {
          message: messageParts,
          config: {
            abortSignal: signal,
          },
        },
        `audio-reader-${Date.now()}`,
        SceneType.IMAGE_READER,
      );

      const transcript = (getResponseText(response) || '').trim();
      if (!transcript) {
        return { transcript: null, error: 'transcription model returned an empty transcript' };
      }
      return { transcript };
    } catch (error) {
      console.error('[AudioReaderTool] Temporary audio transcription failed:', error);
      return { transcript: null, error: getErrorMessage(error) };
    }
  }
}

function formatTranscriptResult(
  transcript: string,
  relativePath: string,
  sourceLabel: string,
): ToolResult {
  const truncated = truncateTranscript(transcript);
  const shortPath = shortenPath(relativePath);
  const header = `Audio transcription for ${shortPath} (via ${sourceLabel}):`;
  return {
    llmContent: `${header}\n\n${truncated.transcript}`,
    returnDisplay: `Transcribed audio: ${shortPath}${truncated.truncated ? ' (truncated)' : ''}`,
  };
}

function getCurrentAudioModelPlan(
  config: Config,
  currentModel: string | undefined,
): { model: string; label: string } | null {
  if (!currentModel || currentModel === 'auto') {
    return null;
  }

  if (isCustomModel(currentModel)) {
    const customModel = typeof config.getCustomModelConfig === 'function'
      ? config.getCustomModelConfig(currentModel)
      : undefined;
    if (!customModel || !customModelSupportsAudio(customModel)) {
      return null;
    }
    return {
      model: currentModel,
      label: customModel.displayName || customModel.modelId || currentModel,
    };
  }

  if (!builtInModelSupportsAudio(currentModel)) {
    return null;
  }
  return { model: currentModel, label: currentModel };
}

function customModelSupportsAudio(model: CustomModelConfig): boolean {
  const capabilities = ((model as CustomModelConfig & { capabilities?: string[] }).capabilities || [])
    .map(capability => capability.toLowerCase());
  if (
    capabilities.some(capability =>
      capability === 'audio' ||
      capability === 'input_audio' ||
      capability === 'audio_input' ||
      capability === 'multimodal' ||
      capability === 'multimodal_audio',
    )
  ) {
    return true;
  }

  const haystack = `${model.provider || ''} ${model.modelId || ''} ${model.displayName || ''}`.toLowerCase();
  if (haystack.includes('gemini')) return true;

  return (
    haystack.includes('audio') ||
    haystack.includes('realtime') ||
    haystack.includes('transcribe') ||
    haystack.includes('gpt-4o')
  );
}

function builtInModelSupportsAudio(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes('gemini') ||
    lower.includes('audio') ||
    lower.includes('realtime') ||
    lower.includes('transcribe') ||
    lower.includes('gpt-4o')
  );
}

async function transcribeWithLocalBridge(filePath: string): Promise<string | null> {
  const scriptPath = path.join(path.dirname(path.dirname(moduleDir)), 'scripts', 'voice_bridge.py');
  if (!fs.existsSync(scriptPath)) return null;

  const pyCommands = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const py of pyCommands) {
    try {
      const result = await execFileAsync(
        py,
        [scriptPath, '--input-file', filePath, '--transcribe-only'],
        {
          timeout: 120_000,
          maxBuffer: 5 * 1024 * 1024,
          windowsHide: true,
        },
      );
      const text = result.stdout.trim();
      if (text) return text;
    } catch {
      // Try the next Python command or report that local ASR is unavailable.
    }
  }
  return null;
}
