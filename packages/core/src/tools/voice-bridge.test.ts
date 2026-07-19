/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * VoiceBridgeTool tests focus on dependency preflight. Missing dependencies
 * should explain whether the feature can work and how the user can fix it
 * before Otto records audio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
      sounddevice_module: true,
      torch_module: false,
      cuda: false,
      user_asr_key: false,
      model_candidates: ['medium', 'small', 'base'],
    });

    const r = await t.execute({ action: 'listen' }, signal());
    const content = String(r.llmContent);
    expect(content).toContain('Runtime check');
    expect(content).toContain('/opt/otto/python');
    expect(content).toContain('openai-whisper Python module: blocked');
    expect(content).toContain('"/opt/otto/python" -m pip install -U openai-whisper');
    expect(content).toContain('medium -> small -> base');
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
