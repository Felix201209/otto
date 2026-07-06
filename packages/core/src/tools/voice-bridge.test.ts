/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * VoiceBridgeTool 单测。重点：doctor 前置对语音依赖的 fail-loud —— 录音需 ffmpeg，
 * 转写需本地 whisper 或云端 key。缺就在录音前明说缺啥怎么装，而不是录了音才失败。
 *
 * 通过注入「装了 fake runner 的真实 DoctorService」模拟缺依赖，不真的录音/转写。
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

/**
 * 构造 fake runner：present 里列出的二进制 which 命中并能报版本，其余全失败。
 */
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
  return new VoiceBridgeTool(createMockConfig(), doctor);
}

const signal = () => new AbortController().signal;

describe('VoiceBridgeTool', () => {
  let tool: VoiceBridgeTool;

  beforeEach(() => {
    // 默认清掉云端 key，避免宿主机环境干扰 whisper 判定。
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ARK_API_KEY', '');
    tool = new VoiceBridgeTool(createMockConfig());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // --- Metadata / validation ---
  it('has correct name', () => {
    expect(VoiceBridgeTool.Name).toBe('voice_bridge');
  });
  it('rejects out-of-range duration', () => {
    expect(tool.validateToolParams({ action: 'listen', duration: 999 })).toContain('duration');
  });
  it('accepts valid listen', () => {
    expect(tool.validateToolParams({ action: 'listen' })).toBeNull();
  });

  // --- doctor 前置：ffmpeg 缺失 fail-loud ---
  it('fails loudly when ffmpeg is missing, with install command', async () => {
    // whisper 装了，ffmpeg 没装。
    const t = toolWith(new Set(['whisper']));
    const r = await t.execute({ action: 'listen' }, signal());
    const content = String(r.llmContent);
    expect(content).toContain('voice_bridge FAIL');
    expect(content).toContain('ffmpeg');
    expect(content).toContain('brew install ffmpeg');
  });

  // --- doctor 前置：whisper 缺失且无云端 key fail-loud ---
  it('fails loudly when whisper missing and no cloud key', async () => {
    // ffmpeg 装了，whisper 没装，无云端 key。
    const t = toolWith(new Set(['ffmpeg']));
    const r = await t.execute({ action: 'listen' }, signal());
    const content = String(r.llmContent);
    expect(content).toContain('voice_bridge FAIL');
    expect(content).toContain('whisper');
    // 应提示本地安装 + 云端 key 两条路。
    expect(content).toContain('openai-whisper');
    expect(content).toContain('OPENAI_API_KEY');
  });

  // --- doctor 前置：whisper 缺失但有云端 key -> whisper 不再拦 ---
  // 说明：「放行」类断言用 preflight（私有）而非 execute，避免放行后真的去跑
  // voice_bridge.py 造成超时/副作用。
  it('does not block on missing whisper when a cloud key is set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    // ffmpeg 装了，whisper 没装，但有云端 key。
    const t = toolWith(new Set(['ffmpeg']));
    const depErr = await callPreflight(t);
    // 不应因 whisper 缺失而拦（有云端 key）。
    expect(depErr).toBeNull();
  });

  // --- doctor 前置：全就绪 -> 不因依赖前置而拦 ---
  it('passes dependency preflight when ffmpeg and whisper both present', async () => {
    const t = toolWith(new Set(['ffmpeg', 'whisper']));
    const depErr = await callPreflight(t);
    expect(depErr).toBeNull();
  });
});

/** 访问私有 preflight（只读依赖体检），避免触发真实录音/脚本执行。 */
function callPreflight(t: VoiceBridgeTool): Promise<string | null> {
  return (t as unknown as { preflight(): Promise<string | null> }).preflight();
}
