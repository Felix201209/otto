/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * Otto Voice Bridge Tool - Lightweight voice input inspired by OpenLess.
 * Records audio -> transcribes -> polishes into structured command.
 * Zero heavy dependencies: uses OS built-in recording + whisper/API.
 *
 * ⚠️ 半成品，暂未注册（见 config.ts）：TS 这层只是薄壳，真正的录音+转写+润色管线
 * 在外部脚本 `scripts/voice_bridge.py` 里，该脚本尚未随代码带出。缺脚本时工具会
 * fail-loud（不崩）。补齐 voice_bridge.py 后，在 config.ts 注册即可启用。
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'node:url';
import os from 'os';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ProcessGuard } from '../utils/process-guard.js';
import { DoctorService, DoctorReport } from '../services/doctor.js';

const execAsync = promisify(exec);
const moduleDir = __dirname;

export interface VoiceBridgeToolParams {
  action: 'listen' | 'listen_raw' | 'listen_long';
  duration?: number;
}

export class VoiceBridgeTool extends BaseTool<VoiceBridgeToolParams, ToolResult> {
  static readonly Name: string = 'voice_bridge';

  /**
   * DoctorService 只读复用：真正录音/转写前先体检依赖。可注入以便测试
   * （测试传入注入了 fake runner 的 DoctorService，模拟缺 ffmpeg/whisper）。
   */
  constructor(private readonly config: Config, private readonly doctor: DoctorService = new DoctorService()) {
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

  /**
   * 执行前依赖体检（fail-loud）：录音需 ffmpeg（必需）；转写需本地 whisper
   * 或云端 key（OPENAI_API_KEY / ARK_API_KEY）二选一。缺就提前返回明确错误 +
   * 安装命令，避免录了音才在管线里失败。python3 不在此拦（脚本缺失时另有 fail-loud）。
   * @returns 缺依赖时返回错误串，全部就绪返回 null。
   */
  private async preflight(): Promise<string | null> {
    let report: DoctorReport;
    try {
      report = await this.doctor.check();
    } catch {
      // 体检本身异常不阻断（保持既有行为，让后续脚本自行 fail）。
      return null;
    }
    const find = (name: string) => report.checks.find((c) => c.name === name);
    const missing: string[] = [];

    const ffmpeg = find('ffmpeg');
    if (ffmpeg && !ffmpeg.present) {
      missing.push(`  - ffmpeg（录音）未安装。安装：${ffmpeg.installHint}`);
    }

    const whisper = find('whisper');
    const hasCloudKey = !!(process.env.OPENAI_API_KEY || process.env.ARK_API_KEY);
    if (whisper && !whisper.present && !hasCloudKey) {
      missing.push(
        `  - whisper（转写）未安装，且未配置云端 key。任选其一：\n` +
        `      本地转写：${whisper.installHint}\n` +
        `      云端转写：设置环境变量 OPENAI_API_KEY 或 ARK_API_KEY`,
      );
    }

    if (missing.length === 0) return null;
    return 'voice_bridge FAIL: 缺少语音依赖，无法录音/转写：\n' + missing.join('\n');
  }

  async execute(p: VoiceBridgeToolParams, _s: AbortSignal): Promise<ToolResult> {
    const err = this.validateToolParams(p);
    if (err) return { llmContent: err, returnDisplay: err };

    const depErr = await this.preflight();
    if (depErr) return { llmContent: depErr, returnDisplay: 'voice_bridge FAIL: 缺少语音依赖（见详情）' };

    const duration = p.duration || (p.action === 'listen_long' ? 60 : 10);
    const mode = p.action === 'listen_raw' ? 'raw' : 'polished';

    try {
      // Find the voice_bridge.py script
      const scriptPath = path.join(path.dirname(path.dirname(moduleDir)), 'scripts', 'voice_bridge.py');
      const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
      const cmd = `${pyCmd} "${scriptPath}" --duration ${duration} --mode ${mode}`;

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
