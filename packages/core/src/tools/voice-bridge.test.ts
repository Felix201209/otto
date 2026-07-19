/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * VoiceBridgeTool tests focus on dependency preflight. Missing dependencies
 * should explain whether the feature can work and how the user can fix it
 * before Otto records audio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import { VoiceBridgeTool } from './voice-bridge.js';
import { createMockConfig } from '../utils/test-helpers.js';
import {
  DoctorService,
  type CommandRunner,
  type ModuleResolver,
} from '../services/doctor.js';

const NO_MODULES: ModuleResolver = () => {
  throw new Error('no modules');
};

function makeRunner(present: Set<string>): CommandRunner {
  return async (command: string) => {
    const w = command.match(/^(?:which|where)\s+(\S+)/);
    if (w) {
      if (present.has(w[1])) return `/usr/local/bin/${w[1]}`;
      throw new Error(`which: ${w[1]} not found`);
    }
    const v = command.match(/^(\S+)\s/);
    if (v && present.has(v[1])) return `${v[1]} version 1.0.0`;
    throw new Error(`${command}: not found`);
  };
}

function toolWith(present: Set<string>): VoiceBridgeTool {
  const doctor = new DoctorService(makeRunner(present), NO_MODULES, 'darwin', () => false);
  return new VoiceBridgeTool(createMockConfig(), doctor, async () => null);
}

function toolWithRuntimeStatus(status: Record<string, unknown>): VoiceBridgeTool {
  return new VoiceBridgeTool(
    createMockConfig(),
    new DoctorService(makeRunner(new Set()), NO_MODULES, 'darwin', () => false),
    async () => status as any,
  );
}

const signal = () => new AbortController().signal;

describe('VoiceBridgeTool', () => {
  let tool: VoiceBridgeTool;

  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ARK_API_KEY', '');
    tool = new VoiceBridgeTool(createMockConfig());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('has correct name', () => {
    expect(VoiceBridgeTool.Name).toBe('voice_bridge');
  });

  it('keeps default TLS certificate verification for Whisper model downloads', () => {
    const bridgeScript = fs.readFileSync(
      new URL('../../scripts/voice_bridge.py', import.meta.url),
      'utf8',
    );

    expect(bridgeScript).not.toContain('_create_unverified_context');
    expect(bridgeScript).not.toMatch(
      /_create_default_https_context\s*=/,
    );
  });

  it('passes the configured temperature schedule to faster-whisper', () => {
    const bridgeScript = fs.readFileSync(
      new URL('../../scripts/voice_bridge.py', import.meta.url),
      'utf8',
    );
    const fasterWhisperBlock = bridgeScript.slice(
      bridgeScript.indexOf('def run_faster_whisper():'),
      bridgeScript.indexOf('def run_openai_whisper():'),
    );

    expect(fasterWhisperBlock).toContain('temperature=temperatures or (0,)');
  });

  it('lets CTranslate2 choose the faster-whisper device without requiring torch', () => {
    const bridgeScript = fs.readFileSync(
      new URL('../../scripts/voice_bridge.py', import.meta.url),
      'utf8',
    );
    const fasterWhisperBlock = bridgeScript.slice(
      bridgeScript.indexOf('def run_faster_whisper():'),
      bridgeScript.indexOf('def run_openai_whisper():'),
    );

    expect(fasterWhisperBlock).toContain('device=faster_device');
    expect(fasterWhisperBlock).toContain('compute_type=faster_compute_type');
    expect(fasterWhisperBlock).not.toContain('device=device');
  });

  it('preserves faster-whisper segment spacing and stops fallback on no speech', () => {
    const bridgeScript = fs.readFileSync(
      new URL('../../scripts/voice_bridge.py', import.meta.url),
      'utf8',
    );
    const fasterWhisperBlock = bridgeScript.slice(
      bridgeScript.indexOf('def run_faster_whisper():'),
      bridgeScript.indexOf('def run_openai_whisper():'),
    );

    expect(fasterWhisperBlock).toContain(
      'text = "".join((segment.text or "") for segment in segments).strip()',
    );
    expect(fasterWhisperBlock).toContain('return False');
    expect(bridgeScript).toContain('if faster_result is False:');
  });

  it('treats local no-speech as terminal before any user API fallback', () => {
    const bridgeScript = fs.readFileSync(
      new URL('../../scripts/voice_bridge.py', import.meta.url),
      'utf8',
    );
    const localWhisperBlock = bridgeScript.slice(
      bridgeScript.indexOf('def transcribe_with_local_whisper('),
      bridgeScript.indexOf('def transcribe_with_user_api('),
    );
    const transcribeBlock = bridgeScript.slice(
      bridgeScript.indexOf('def transcribe(audio_path'),
      bridgeScript.indexOf('def polish_to_command('),
    );
    const localResultIndex = transcribeBlock.indexOf(
      'text = transcribe_with_local_whisper(normalized_path)',
    );
    const noSpeechIndex = transcribeBlock.indexOf('if text is NO_SPEECH:');
    const userApiIndex = transcribeBlock.indexOf(
      'text = transcribe_with_user_api(normalized_path)',
    );

    expect(localWhisperBlock).toContain(
      'if result.returncode == NO_SPEECH_EXIT_CODE:',
    );
    expect(localWhisperBlock).toContain('return NO_SPEECH');
    expect(localResultIndex).toBeGreaterThanOrEqual(0);
    expect(noSpeechIndex).toBeGreaterThan(localResultIndex);
    expect(userApiIndex).toBeGreaterThan(noSpeechIndex);
  });

  it('rejects out-of-range duration', () => {
    expect(tool.validateToolParams({ action: 'listen', duration: 999 })).toContain('duration');
  });

  it('accepts valid listen', () => {
    expect(tool.validateToolParams({ action: 'listen' })).toBeNull();
  });

  it('explains capability and install command when ffmpeg is missing', async () => {
    const t = toolWith(new Set(['whisper']));
    const r = await t.execute({ action: 'listen' }, signal());
    const content = String(r.llmContent);
    expect(content).toContain('voice_bridge SETUP NEEDED');
    expect(content).toContain('Capability check');
    expect(content).toContain('ffmpeg');
    expect(content).toContain('brew install ffmpeg');
    expect(content).toContain('What Otto can do now');
  });

  it('explains local transcription setup when whisper is missing and no user ASR key exists', async () => {
    const t = toolWith(new Set(['ffmpeg']));
    const r = await t.execute({ action: 'listen' }, signal());
    const content = String(r.llmContent);
    expect(content).toContain('voice_bridge SETUP NEEDED');
    expect(content).toContain('Local speech-to-text: blocked');
    expect(content).toContain('Whisper');
    expect(content).toContain('openai-whisper');
    expect(content).toContain('OTTO_WHISPER_MODEL');
    expect(content).toContain('OPENAI_API_KEY');
  });

  it('uses runtime diagnostics to show exact Python module install command', async () => {
    const t = toolWithRuntimeStatus({
      python: '/opt/otto/python',
      python_version: '3.11.9',
      ffmpeg: '/usr/local/bin/ffmpeg',
      whisper_module: false,
      faster_whisper_module: false,
      sounddevice_module: true,
      torch_module: false,
      cuda: false,
      user_asr_key: false,
      model_candidates: ['medium', 'small', 'base'],
      asr_backend: 'auto',
      asr_backend_valid: true,
      beam_size: 5,
      temperature_schedule: '0,0.2',
      faster_whisper_device: 'auto',
      faster_whisper_compute_type: 'default',
    });

    const r = await t.execute({ action: 'listen' }, signal());
    const content = String(r.llmContent);
    expect(content).toContain('Runtime check');
    expect(content).toContain('/opt/otto/python');
    expect(content).toContain('openai-whisper Python module: blocked');
    expect(content).toContain('"/opt/otto/python" -m pip install -U openai-whisper');
    expect(content).toContain('"/opt/otto/python" -m pip install -U faster-whisper');
    expect(content).toContain('faster-whisper optimized backend: not installed');
    expect(content).toContain('medium -> small -> base');
    expect(content).toContain('beam_size=5');
    expect(content).toContain('faster_device=auto/default');
  });

  it('passes runtime preflight when faster-whisper is the available local backend', async () => {
    const t = toolWithRuntimeStatus({
      python: '/opt/otto/python',
      python_version: '3.11.9',
      ffmpeg: '/usr/local/bin/ffmpeg',
      whisper_module: false,
      faster_whisper_module: true,
      sounddevice_module: true,
      user_asr_key: false,
      asr_backend: 'auto',
    });

    const depErr = await callPreflight(t);
    expect(depErr).toBeNull();
  });

  it('fails preflight with a clear error for an unsupported ASR backend', async () => {
    const t = toolWithRuntimeStatus({
      python: '/opt/otto/python',
      ffmpeg: '/usr/local/bin/ffmpeg',
      whisper_module: true,
      faster_whisper_module: true,
      sounddevice_module: true,
      user_asr_key: false,
      asr_backend: 'faster',
      asr_backend_valid: false,
    });

    const depErr = await callPreflight(t);
    expect(depErr).toContain('OTTO_ASR_BACKEND');
    expect(depErr).toContain('faster-whisper');
    expect(depErr).toContain('openai-whisper');
  });

  it('does not block on missing whisper when a user ASR key is set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const t = toolWith(new Set(['ffmpeg']));
    const depErr = await callPreflight(t);
    expect(depErr).toBeNull();
  });

  it('passes dependency preflight when ffmpeg and whisper both present', async () => {
    const t = toolWith(new Set(['ffmpeg', 'whisper']));
    const depErr = await callPreflight(t);
    expect(depErr).toBeNull();
  });
});

function callPreflight(t: VoiceBridgeTool): Promise<string | null> {
  return (t as unknown as { preflight(): Promise<string | null> }).preflight();
}
