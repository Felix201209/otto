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
import { isCustomModel, generateCustomModelId } from '../types/customModel.js';

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
 * Used as a fallback when the active text-only model cannot directly accept
 * audio content.
 *
 * The model can call this tool with the local audio path; we offload the
 * transcription work to a cheap Gemini Flash chat created via `createTemporaryChat`,
 * and return the resulting transcription or summary.
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
        'It first tries Otto local transcription (local Whisper / user cloud ASR env), ' +
        'then falls back to a cheap model (gemini-2.5-flash) when available. ' +
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

    const localTranscript = await this.localTranscriber(filePath);
    if (localTranscript) {
      const truncated = truncateTranscript(localTranscript);
      const header = `Audio transcription for ${shortenPath(relative)} (via local ASR):`;
      return {
        llmContent: `${header}\n\n${truncated.transcript}`,
        returnDisplay: `Transcribed audio locally: ${shortenPath(relative)}${truncated.truncated ? ' (truncated)' : ''}`,
      };
    }

    // Check if using a custom model only after local ASR has failed. This lets
    // Doubao/DeepSeek-style text models still transcribe audio when the user has
    // local Whisper or user-owned cloud ASR configured.
    const currentModel = typeof this.config.getModel === 'function' ? this.config.getModel() : undefined;
    const isUsingCustomModel = currentModel ? isCustomModel(currentModel) : false;
    let resolvedModel: string | undefined = undefined;

    if (isUsingCustomModel && typeof this.config.getCustomModels === 'function') {
      const customModels = this.config.getCustomModels() || [];
      const geminiFlashModel = customModels.find(m => {
        if (m.enabled === false) return false;
        const modelIdLower = (m.modelId || '').toLowerCase();
        const displayNameLower = (m.displayName || '').toLowerCase();
        return (modelIdLower.includes('gemini') && modelIdLower.includes('flash')) ||
               (displayNameLower.includes('gemini') && displayNameLower.includes('flash'));
      });

      if (!geminiFlashModel) {
        return {
          llmContent:
            `Audio transcription is not configured for this model yet.\n\n` +
            `Otto first tried local ASR, but no local/user-owned transcriber returned text. ` +
            `Because the current chat model is custom and no Gemini Flash fallback is configured, ` +
            `this audio file cannot be transcribed automatically.\n\n` +
            `To enable this without Otto-hosted ASR costs, choose one option:\n` +
            `1. Install local Whisper: pip install openai-whisper\n` +
            `2. Configure user-owned ASR env vars: OPENAI_API_KEY or ARK_API_KEY\n` +
            `3. Add a custom Gemini Flash model for multimodal fallback\n` +
            `4. Upload/paste an existing transcript and I can summarize the meeting notes.`,
          returnDisplay: `Audio transcription needs local ASR or a user-owned ASR key`,
        };
      }
      resolvedModel = generateCustomModelId(geminiFlashModel);
    }

    // Read and convert to base64
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

    // Delegate the actual transcription work to a cheap, dedicated Gemini Flash chat.
    try {
      const geminiClient = this.config.getOttoClient();
      const temporaryChat = await geminiClient.createTemporaryChat(
        SceneType.IMAGE_READER, // Reuse image reader scene since both are cheap visual/multimodal fallback scenes
        resolvedModel, // use scene-recommended model (gemini-2.5-flash) or custom Gemini Flash model
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

      let transcript = (getResponseText(response) || '').trim();

      if (!transcript) {
        return {
          llmContent: `Error: transcription model returned an empty transcript for "${filePath}".`,
          returnDisplay: 'Empty transcript from model',
        };
      }

      const truncated = truncateTranscript(transcript);
      const header = `Audio transcription for ${shortenPath(relative)} (via ${isUsingCustomModel ? 'custom model' : 'gemini-2.5-flash'}):`;

      return {
        llmContent: `${header}\n\n${truncated.transcript}`,
        returnDisplay: `Transcribed audio: ${shortenPath(relative)}${truncated.truncated ? ' (truncated)' : ''}`,
      };
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      console.error(
        `[AudioReaderTool] Failed to transcribe audio "${filePath}":`,
        error,
      );
      return {
        llmContent: `Error transcribing audio "${filePath}": ${errorMessage}`,
        returnDisplay: `Error transcribing audio: ${errorMessage}`,
      };
    }
  }
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
      // Try the next Python command or fall through to multimodal fallback.
    }
  }
  return null;
}
