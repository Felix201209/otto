import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type AsrProvider = 'volcengine' | 'openai';

export interface VoicePublicConfig {
  enabled: boolean;
  asrProvider: AsrProvider;
  asrEndpoint: string;
  asrModel: string;
  volcResourceId: string;
  polishEnabled: boolean;
  polishEndpoint: string;
  polishModel: string;
  polishPrompt: string;
  hasAsrApiKey: boolean;
  hasVolcCredentials: boolean;
  hasPolishApiKey: boolean;
}

export interface VoiceConfigInput extends Omit<VoicePublicConfig, 'hasAsrApiKey' | 'hasVolcCredentials' | 'hasPolishApiKey'> {
  asrApiKey?: string;
  volcAppKey?: string;
  volcAccessKey?: string;
  polishApiKey?: string;
}

export interface VoiceSecrets {
  asrApiKey: string;
  volcAppKey: string;
  volcAccessKey: string;
  polishApiKey: string;
}

export interface LoadedVoiceConfig {
  public: VoicePublicConfig;
  secrets: VoiceSecrets;
}

const DEFAULTS: Omit<VoicePublicConfig, 'hasAsrApiKey' | 'hasVolcCredentials' | 'hasPolishApiKey'> = {
  enabled: false,
  asrProvider: 'volcengine',
  asrEndpoint: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
  asrModel: 'bigmodel',
  volcResourceId: 'volc.bigasr.auc_turbo',
  polishEnabled: true,
  polishEndpoint: 'https://api.deepseek.com/v1/chat/completions',
  polishModel: 'deepseek-chat',
  polishPrompt: '你是语音输入整理助手。只修正错别字、标点和口语重复，保留原意，不回答内容，不添加解释，只输出整理后的文字。',
};

function root(): string {
  return path.join(os.homedir(), '.otto-user');
}
function configPath(): string {
  return path.join(root(), 'voice-input.json');
}
function secretPath(name: string): string {
  return path.join(root(), 'secrets', `voice-${name}`);
}
function readSecret(name: string): string {
  try { return fs.readFileSync(secretPath(name), 'utf-8').trim(); } catch { return ''; }
}
function writeSecret(name: string, value?: string): void {
  if (!value?.trim()) return;
  const dir = path.dirname(secretPath(name));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretPath(name), value.trim() + '\n', { mode: 0o600 });
  fs.chmodSync(secretPath(name), 0o600);
}
function validateUrl(value: string): void {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('语音接口必须使用 HTTPS（本机 loopback 可使用 HTTP）');
  }
}

export function loadVoiceConfig(): LoadedVoiceConfig {
  let saved: Partial<typeof DEFAULTS> = {};
  try { saved = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Partial<typeof DEFAULTS>; } catch { /* defaults */ }
  const base = { ...DEFAULTS, ...saved };
  const secrets: VoiceSecrets = {
    asrApiKey: readSecret('asr-api-key'),
    volcAppKey: readSecret('volc-app-key'),
    volcAccessKey: readSecret('volc-access-key'),
    polishApiKey: readSecret('polish-api-key'),
  };
  return {
    public: {
      ...base,
      hasAsrApiKey: Boolean(secrets.asrApiKey),
      hasVolcCredentials: Boolean(secrets.volcAppKey && secrets.volcAccessKey),
      hasPolishApiKey: Boolean(secrets.polishApiKey),
    },
    secrets,
  };
}

export function saveVoiceConfig(input: VoiceConfigInput): VoicePublicConfig {
  validateUrl(input.asrEndpoint);
  if (input.polishEnabled) validateUrl(input.polishEndpoint);
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  const { asrApiKey, volcAppKey, volcAccessKey, polishApiKey, ...publicInput } = input;
  fs.writeFileSync(configPath(), JSON.stringify(publicInput, null, 2), { mode: 0o600 });
  writeSecret('asr-api-key', asrApiKey);
  writeSecret('volc-app-key', volcAppKey);
  writeSecret('volc-access-key', volcAccessKey);
  writeSecret('polish-api-key', polishApiKey);
  return loadVoiceConfig().public;
}
