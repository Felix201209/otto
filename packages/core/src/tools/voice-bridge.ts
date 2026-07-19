/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Voice Bridge Tool - records microphone audio, transcribes it, and
 * optionally polishes it into a structured Otto instruction.
 */

import path from 'path';
import { fileURLToPath } from 'node:url';
import {
  BaseTool,
  ToolResult,
  ToolCallConfirmationDetails,
  Icon,
  ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config } from '../config/config.js';
import { ProcessGuard } from '../utils/process-guard.js';
import { DoctorService, DoctorReport } from '../services/doctor.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface VoiceBridgeToolParams {
  action: 'listen' | 'listen_raw' | 'listen_long';
  duration?: number;
}

export class VoiceBridgeTool extends BaseTool<VoiceBridgeToolParams, ToolResult> {
  static readonly Name: string = 'voice_bridge';

  constructor(private readonly config: Config, private readonly doctor: DoctorService = new DoctorService()) {
    const desc = `Voice input bridge - speak naturally, get structured text back.

EXAMPLES:
  Quick command: {action:"listen"}           -- records 10s, polishes via LLM
  Raw transcript: {action:"listen_raw"}      -- records 10s, returns raw text
  Long dictation: {action:"listen_long", duration:60} -- records 60s

HOW IT WORKS:
  1. Records audio from the microphone.
  2. Transcribes via local Whisper or a user-owned ASR API key.
  3. Polishes raw speech into a clean structured instruction when requested.

REQUIREMENTS:
  Recording/audio decode: ffmpeg
  Local transcription: pip install -U openai-whisper
  Optional quality: OTTO_WHISPER_MODEL=small|medium|large-v3`;

    super(VoiceBridgeTool.Name, 'VoiceBridge', desc, Icon.Terminal,
      {
        type: Type.OBJECT,
        properties: {
          action: {
            type: Type.STRING,
            description: 'Listen mode',
            enum: ['listen', 'listen_raw', 'listen_long'],
          },
          duration: {
            type: Type.NUMBER,
            description: 'Recording duration in seconds. Default: 10 (listen/listen_raw) or 60 (listen_long)',
          },
        },
        required: ['action'],
      },
    );
  }

  validateToolParams(p: VoiceBridgeToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, VoiceBridgeTool.Name);
    if (e) return e;
    if (p.duration && (p.duration < 1 || p.duration > 300)) return 'voice_bridge: duration must be 1-300 seconds';
    return null;
  }

  toolLocations(): ToolLocation[] { return []; }

  getDescription(p: VoiceBridgeToolParams): string {
    const d = p.duration || (p.action === 'listen_long' ? 60 : 10);
    return `voice: ${p.action} (${d}s)`;
  }

  async shouldConfirmExecute(_p: VoiceBridgeToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    return false;
  }

  private async preflight(): Promise<string | null> {
    let report: DoctorReport;
    try {
      report = await this.doctor.check();
    } catch {
      return null;
    }

    const find = (name: string) => report.checks.find((c) => c.name === name);
    const ffmpeg = find('ffmpeg');
    const whisper = find('whisper');
    const hasUserAsrKey = !!(process.env.OPENAI_API_KEY || process.env.ARK_API_KEY);

    const missing: string[] = [];
    if (ffmpeg && !ffmpeg.present) {
      missing.push(
        `- ffmpeg is missing, so Otto may not be able to record or decode audio.\n` +
        `  Install: ${ffmpeg.installHint}`,
      );
    }
    if (whisper && !whisper.present && !hasUserAsrKey) {
      missing.push(
        `- Whisper is missing, so local speech-to-text is not available.\n` +
        `  Install: ${whisper.installHint}\n` +
        `  Accuracy setting: set OTTO_WHISPER_MODEL=medium, small, or large-v3\n` +
        `  Alternative: configure a user-owned ASR key with OPENAI_API_KEY or ARK_API_KEY`,
      );
    }

    if (missing.length === 0) return null;

    return (
      `voice_bridge SETUP NEEDED\n\n` +
      `Capability check:\n` +
      `- Microphone recording/audio decode: ${ffmpeg?.present ? 'ready' : 'blocked'}\n` +
      `- Local speech-to-text: ${whisper?.present ? 'ready' : hasUserAsrKey ? 'ready via user-owned ASR key' : 'blocked'}\n\n` +
      `What Otto can do now:\n` +
      `- If you paste an existing transcript, Otto can summarize it immediately.\n` +
      `- If the current chat model supports audio, Otto can still try that model first.\n` +
      `- For local recording/transcription, install the missing dependency below.\n\n` +
      `Fix steps:\n${missing.join('\n')}\n\n` +
      `After installing, restart Otto or the terminal, then retry the voice action.`
    );
  }

  async execute(p: VoiceBridgeToolParams, _s: AbortSignal): Promise<ToolResult> {
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    const depErr = await this.preflight();
    if (depErr) {
      return {
        llmContent: depErr,
        returnDisplay: 'voice_bridge SETUP NEEDED: install audio dependencies',
      };
    }

    const duration = p.duration || (p.action === 'listen_long' ? 60 : 10);
    const mode = p.action === 'listen_raw' ? 'raw' : 'polished';

    try {
      const scriptPath = path.join(path.dirname(path.dirname(moduleDir)), 'scripts', 'voice_bridge.py');
      const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
      const cmd = `${pyCmd} "${scriptPath}" --duration ${duration} --mode ${mode}`;

      const result = await ProcessGuard.exec({
        command: cmd,
        timeoutMs: duration * 1000 + 30000,
        maxBuffer: 5 * 1024 * 1024,
      });

      const text = result.stdout.trim();
      if (!text) {
        return {
          llmContent:
            `voice_bridge NO SPEECH DETECTED\n\n` +
            `Otto recorded audio but did not receive usable speech text.\n` +
            `Try again closer to the microphone, increase duration, or check microphone permissions.`,
          returnDisplay: 'voice_bridge NO SPEECH DETECTED',
        };
      }

      return {
        llmContent: 'voice_bridge OK: ' + text,
        returnDisplay: 'voice_bridge OK: ' + text.substring(0, 100),
      };
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return {
        llmContent:
          `voice_bridge FAILED\n\n` +
          `Reason: ${m}\n\n` +
          `How to fix:\n` +
          `- Check microphone permission for Otto or the terminal.\n` +
          `- Install ffmpeg for recording and audio decoding.\n` +
          `- Install local Whisper with: pip install -U openai-whisper\n` +
          `- If the computer is slow, set OTTO_WHISPER_MODEL=small and retry.`,
        returnDisplay: 'voice_bridge FAILED: ' + m,
      };
    }
  }
}
