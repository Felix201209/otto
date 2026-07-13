import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { VoiceSettings } from './VoiceSettings.js';

const config = {
  enabled: true,
  asrProvider: 'volcengine' as const,
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
};
const save = vi.fn(async () => config);

beforeEach(() => {
  save.mockClear();
  (window as unknown as { otto: unknown }).otto = {
    voiceGetConfig: async () => config,
    voiceSaveConfig: save,
  };
});

describe('VoiceSettings', () => {
  it('折叠加载配置并保存，密钥输入留空表示保留', async () => {
    const { getByRole, getByDisplayValue, getByText } = render(<VoiceSettings />);
    fireEvent.click(getByRole('button', { name: /语音输入/ }));
    await waitFor(() => expect(getByDisplayValue('deepseek-chat')).toBeTruthy());
    fireEvent.click(getByText('保存语音配置'));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      volcAppKey: '',
      volcAccessKey: '',
      polishApiKey: '',
    })));
  });
});
