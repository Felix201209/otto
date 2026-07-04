/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Voice Bridge Tool - Lightweight voice input inspired by OpenLess.
 * Records audio -> transcribes -> polishes into structured command.
 * Zero heavy dependencies: uses OS built-in recording + whisper/API.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  ToolConfirmationOutcome, Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ProcessGuard } from '../utils/process-guard.js';

const execAsync = promisify(exec);

export interface VoiceBridgeToolParams {
  action: 'listen' | 'listen_raw' | 'listen_long';
  duration?: number;
}

export class VoiceBridgeTool extends BaseTool<VoiceBridgeToolParams, ToolResult> {
  static readonly Name: string = 'voice_bridge';

  constructor(private readonly config: Config) {
    const desc = `Voice input bridge - speak naturally, get structured text back.

EXAMPLES:
  Quick command: {action:"listen"}           -- records 10s, polishes via LLM
  Raw transcript: {action:"listen_raw"}      -- records 10s, returns raw text
  Long dictation: {action:"listen_long", duration:60} -- records 60s

HOW IT WORKS:
  1. Records audio from microphone (afrecord on macOS, sounddevice on Windows)
  2. Transcribes via local whisper or cloud API (OPENAI_API_KEY / ARK_API_KEY)
  3. Polishes raw speech into clean structured instruction via LLM
  4. Returns the text for Otto to execute

REQUIREMENTS:
  macOS: afrecord (built-in), whisper (pip install openai-whisper) recommended
  Windows: pip install sounddevice
  LLM polish: set OPENAI_API_KEY or ARK_API_KEY env var (optional, falls back to raw)`;

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
    return false; // voice input is safe, auto-approve
  }

  async execute(p: VoiceBridgeToolParams, _s: AbortSignal): Promise<ToolResult> {
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    const duration = p.duration || (p.action === 'listen_long' ? 60 : 10);
    const mode = p.action === 'listen_raw' ? 'raw' : 'polished';

    try {
      // Find the voice_bridge.py script
      const scriptPath = path.join(path.dirname(path.dirname(__dirname)), 'scripts', 'voice_bridge.py');
      const cmd = `python3 "${scriptPath}" --duration ${duration} --mode ${mode}`;

      const result = await ProcessGuard.exec({
        command: cmd,
        timeoutMs: duration * 1000 + 30000, // recording + transcription time
        maxBuffer: 5 * 1024 * 1024,
      });

      const text = result.stdout.trim();
      if (!text) {
        return {
          llmContent: 'voice_bridge FAIL: No speech detected',
          returnDisplay: 'voice_bridge FAIL: No speech detected',
        };
      }

      return {
        llmContent: 'voice_bridge OK: ' + text,
        returnDisplay: 'voice_bridge OK: ' + text.substring(0, 100),
      };
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      return {
        llmContent: 'voice_bridge FAIL: ' + m,
        returnDisplay: 'voice_bridge FAIL: ' + m,
      };
    }
  }
}
