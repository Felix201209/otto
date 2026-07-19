/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Voice Bridge Tool - records microphone audio, transcribes it, and
 * optionally polishes it into a structured Otto instruction.
 */

import path from 'path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { DoctorService, DoctorReport } from '../services/doctor.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

interface PythonCommand {
  command: string;
  prefixArgs: string[];
}

interface VoiceBridgeDependencyStatus {
  python?: string;
  python_version?: string;
  ffmpeg?: string | null;
  whisper_module?: boolean;
  faster_whisper_module?: boolean;
  sounddevice_module?: boolean;
  requests_module?: boolean;
  torch_module?: boolean;
  cuda?: boolean;
  user_asr_key?: boolean;
  model_candidates?: string[];
  asr_backend?: string;
  beam_size?: number;
  temperature_schedule?: string;
  timeout_seconds?: number;
}

type VoiceBridgeDependencyChecker = () => Promise<VoiceBridgeDependencyStatus | null>;

function getPythonCommands(): PythonCommand[] {
  return process.platform === 'win32'
    ? [
        { command: 'python', prefixArgs: [] },
        { command: 'py', prefixArgs: ['-3'] },
        { command: 'python3', prefixArgs: [] },
      ]
    : [
        { command: 'python3', prefixArgs: [] },
        { command: 'python', prefixArgs: [] },
      ];
}

function getVoiceBridgeScriptPath(): string {
  return path.join(path.dirname(path.dirname(moduleDir)), 'scripts', 'voice_bridge.py');
}

async function runVoiceBridgeDependencyCheck(): Promise<VoiceBridgeDependencyStatus | null> {
  const scriptPath = getVoiceBridgeScriptPath();
  for (const py of getPythonCommands()) {
    try {
      const result = await execFileAsync(
        py.command,
        [...py.prefixArgs, scriptPath, '--check-deps'],
        {
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      const parsed = JSON.parse(result.stdout.trim()) as VoiceBridgeDependencyStatus;
      return parsed;
    } catch {
      // Try the next Python launcher.
    }
  }
  return null;
}

export interface VoiceBridgeToolParams {
  action: 'listen' | 'listen_raw' | 'listen_long';
  duration?: number;
}

export class VoiceBridgeTool extends BaseTool<VoiceBridgeToolParams, ToolResult> {
  static readonly Name: string = 'voice_bridge';

  constructor(
    private readonly config: Config,
    private readonly doctor: DoctorService = new DoctorService(),
    private readonly dependencyChecker: VoiceBridgeDependencyChecker = runVoiceBridgeDependencyCheck,
  ) {
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
    const runtimeStatus = await this.dependencyChecker();
    if (runtimeStatus) {
      return this.preflightFromRuntimeStatus(runtimeStatus);
    }

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

  private preflightFromRuntimeStatus(status: VoiceBridgeDependencyStatus): string | null {
    const hasUserAsrKey = !!status.user_asr_key || !!(process.env.OPENAI_API_KEY || process.env.ARK_API_KEY);
    const missing: string[] = [];

    if (!status.ffmpeg) {
      missing.push(
        `- ffmpeg is missing, so recording/audio decoding may fail.\n` +
        `  Windows: winget install --id Gyan.FFmpeg\n` +
        `  macOS: brew install ffmpeg\n` +
        `  Linux: sudo apt-get install -y ffmpeg`,
      );
    }
    if (!status.whisper_module && !hasUserAsrKey) {
      missing.push(
        `- Python module openai-whisper is missing, so local speech-to-text is not available.\n` +
        `  Install with the same Python Otto is using:\n` +
        `  "${status.python || 'python'}" -m pip install -U openai-whisper\n` +
        `  Optional faster backend: "${status.python || 'python'}" -m pip install -U faster-whisper\n` +
        `  Low-spec computer: set OTTO_WHISPER_MODEL=small`,
      );
    }
    if (!status.sounddevice_module && !status.ffmpeg) {
      missing.push(
        `- sounddevice is also missing, so Otto has no fallback microphone recorder.\n` +
        `  Install with: "${status.python || 'python'}" -m pip install sounddevice`,
      );
    }

    if (missing.length === 0) return null;

    return (
      `voice_bridge SETUP NEEDED\n\n` +
      `Runtime check:\n` +
      `- Python: ${status.python ? `${status.python} (${status.python_version || 'unknown version'})` : 'blocked'}\n` +
      `- ffmpeg: ${status.ffmpeg ? 'ready' : 'blocked'}\n` +
      `- openai-whisper Python module: ${status.whisper_module ? 'ready' : hasUserAsrKey ? 'not installed, but user ASR key is available' : 'blocked'}\n` +
      `- faster-whisper optimized backend: ${status.faster_whisper_module ? 'ready' : 'not installed'}\n` +
      `- sounddevice microphone fallback: ${status.sounddevice_module ? 'ready' : 'not installed'}\n` +
      `- GPU acceleration: ${status.cuda ? 'available' : status.torch_module ? 'not available' : 'torch not installed yet'}\n` +
      `- ASR backend: ${status.asr_backend || 'auto'}\n` +
      `- Whisper model plan: ${(status.model_candidates || ['auto']).join(' -> ')}\n\n` +
      `- Decode quality: beam_size=${status.beam_size || 5}, temperatures=${status.temperature_schedule || '0,0.2'}\n\n` +
      `What Otto can do now:\n` +
      `- If you paste an existing transcript, Otto can summarize it immediately.\n` +
      `- If the current chat model supports audio, Otto can still try that model first.\n` +
      `- For reliable local recording/transcription, complete the fix steps below.\n\n` +
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

    const pyCommands = getPythonCommands();
    let lastError = '';

    for (const py of pyCommands) {
      const scriptPath = getVoiceBridgeScriptPath();
      try {
        const result = await execFileAsync(
          py.command,
          [...py.prefixArgs, scriptPath, '--duration', String(duration), '--mode', mode],
          {
            timeout: duration * 1000 + 360_000,
            maxBuffer: 5 * 1024 * 1024,
            windowsHide: true,
          },
        );

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
        lastError = e instanceof Error ? e.message : String(e);
      }
    }

    return {
      llmContent:
        `voice_bridge FAILED\n\n` +
        `Reason: ${lastError || 'No Python command could run the voice bridge.'}\n\n` +
        `How to fix:\n` +
        `- Install Python 3 and make sure python, py -3, or python3 works in the terminal.\n` +
        `- Check microphone permission for Otto or the terminal.\n` +
        `- Install ffmpeg for recording and audio decoding.\n` +
        `- Install local Whisper with: pip install -U openai-whisper\n` +
        `- If the computer is slow, set OTTO_WHISPER_MODEL=small and retry.`,
      returnDisplay: 'voice_bridge FAILED: ' + (lastError || 'Python unavailable'),
    };
  }
}
