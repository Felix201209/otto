import { randomUUID } from 'node:crypto';
import type { LoadedVoiceConfig } from './voiceConfig.js';

export interface VoiceResult { text: string; rawText: string; polished: boolean }

async function transcribeVolc(audio: Uint8Array, cfg: LoadedVoiceConfig, fetcher: typeof fetch): Promise<string> {
  const { public: p, secrets: s } = cfg;
  if (!s.volcAppKey || !s.volcAccessKey) throw new Error('请先配置火山引擎 App Key 和 Access Key');
  const response = await fetcher(p.asrEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Api-App-Key': s.volcAppKey,
      'X-Api-Access-Key': s.volcAccessKey,
      'X-Api-Resource-Id': p.volcResourceId,
      'X-Api-Request-Id': randomUUID(),
      'X-Api-Sequence': '-1',
    },
    body: JSON.stringify({
      user: { uid: s.volcAppKey },
      audio: { data: Buffer.from(audio).toString('base64') },
      request: { model_name: p.asrModel || 'bigmodel', enable_itn: true, enable_punc: true },
    }),
  });
  const status = response.headers.get('X-Api-Status-Code');
  const json = await response.json() as { result?: { text?: string }; message?: string };
  if (!response.ok || (status && status !== '20000000')) throw new Error(json.message || `火山语音识别失败（${status || response.status}）`);
  return json.result?.text?.trim() || '';
}

async function transcribeOpenAI(audio: Uint8Array, mimeType: string, cfg: LoadedVoiceConfig, fetcher: typeof fetch): Promise<string> {
  const { public: p, secrets: s } = cfg;
  if (!s.asrApiKey) throw new Error('请先配置语音识别 API Key');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), mimeType.includes('wav') ? 'speech.wav' : 'speech.webm');
  form.append('model', p.asrModel);
  const response = await fetcher(p.asrEndpoint, { method: 'POST', headers: { Authorization: `Bearer ${s.asrApiKey}` }, body: form });
  const json = await response.json() as { text?: string; error?: { message?: string } };
  if (!response.ok) throw new Error(json.error?.message || `语音识别失败（${response.status}）`);
  return json.text?.trim() || '';
}

async function polish(raw: string, cfg: LoadedVoiceConfig, fetcher: typeof fetch): Promise<string> {
  const { public: p, secrets: s } = cfg;
  if (!s.polishApiKey) throw new Error('未配置润色 API Key');
  const response = await fetcher(p.polishEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${s.polishApiKey}` },
    body: JSON.stringify({ model: p.polishModel, temperature: 0.1, messages: [{ role: 'system', content: p.polishPrompt }, { role: 'user', content: raw }] }),
  });
  const json = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(json.error?.message || `润色失败（${response.status}）`);
  return json.choices?.[0]?.message?.content?.trim() || raw;
}

export async function transcribeAudio(audio: Uint8Array, mimeType: string, cfg: LoadedVoiceConfig, fetcher: typeof fetch = fetch): Promise<VoiceResult> {
  const rawText = cfg.public.asrProvider === 'volcengine'
    ? await transcribeVolc(audio, cfg, fetcher)
    : await transcribeOpenAI(audio, mimeType, cfg, fetcher);
  if (!rawText) throw new Error('没有识别到语音内容');
  if (!cfg.public.polishEnabled) return { text: rawText, rawText, polished: false };
  try {
    const text = await polish(rawText, cfg, fetcher);
    return { text, rawText, polished: text !== rawText };
  } catch {
    return { text: rawText, rawText, polished: false };
  }
}
