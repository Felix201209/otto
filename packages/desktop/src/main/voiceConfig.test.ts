import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadVoiceConfig, saveVoiceConfig } from './voiceConfig.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-voice-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('voiceConfig', () => {
  it('保存非敏感配置并把凭证拆到 0600 secret 文件', () => {
    saveVoiceConfig({
      enabled: true,
      asrProvider: 'volcengine',
      asrEndpoint: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
      asrModel: 'bigmodel',
      asrApiKey: '',
      volcAppKey: 'app',
      volcAccessKey: 'access',
      volcResourceId: 'volc.bigasr.auc_turbo',
      polishEnabled: true,
      polishEndpoint: 'https://api.deepseek.com/v1/chat/completions',
      polishModel: 'deepseek-chat',
      polishApiKey: 'sk-deepseek',
      polishPrompt: '整理文本',
    });
    const loaded = loadVoiceConfig();
    expect(loaded.public.hasVolcCredentials).toBe(true);
    expect(loaded.public.hasPolishApiKey).toBe(true);
    expect(JSON.stringify(loaded.public)).not.toContain('sk-deepseek');
    expect(loaded.secrets.volcAccessKey).toBe('access');
    const secret = path.join(home, '.otto-user', 'secrets', 'voice-volc-access-key');
    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
  });
});
