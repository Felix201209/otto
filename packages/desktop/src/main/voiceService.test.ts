import { describe, expect, it, vi } from 'vitest';
import { transcribeAudio } from './voiceService.js';

describe('voiceService', () => {
  it('调用火山录音极速接口并用润色失败回退原文', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { text: '原始文字' } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'X-Api-Status-Code': '20000000' },
      }))
      .mockRejectedValueOnce(new Error('polish down'));
    const result = await transcribeAudio(new Uint8Array([1, 2]), 'audio/webm', {
      public: {
        enabled: true,
        asrProvider: 'volcengine',
        asrEndpoint: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
        asrModel: 'bigmodel',
        volcResourceId: 'volc.bigasr.auc_turbo',
        polishEnabled: true,
        polishEndpoint: 'https://api.deepseek.com/v1/chat/completions',
        polishModel: 'deepseek-chat',
        polishPrompt: '整理',
        hasAsrApiKey: false,
        hasVolcCredentials: true,
        hasPolishApiKey: true,
      },
      secrets: { asrApiKey: '', volcAppKey: 'app', volcAccessKey: 'access', polishApiKey: 'key' },
    }, fetcher as typeof fetch);
    expect(result).toEqual({ text: '原始文字', rawText: '原始文字', polished: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
