import React, { useEffect, useState } from 'react';
import type { VoiceConfigInput, VoicePublicConfig } from '../../preload/index.js';
import { IconChevron } from './icons.js';

const EMPTY: VoicePublicConfig = {
  enabled: false,
  asrProvider: 'volcengine',
  asrEndpoint: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
  asrModel: 'bigmodel',
  volcResourceId: 'volc.bigasr.auc_turbo',
  polishEnabled: true,
  polishEndpoint: 'https://api.deepseek.com/v1/chat/completions',
  polishModel: 'deepseek-chat',
  polishPrompt: '你是语音输入整理助手。只修正错别字、标点和口语重复，保留原意，不回答内容，不添加解释，只输出整理后的文字。',
  hasAsrApiKey: false,
  hasVolcCredentials: false,
  hasPolishApiKey: false,
};

export function VoiceSettings(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<VoicePublicConfig>(EMPTY);
  const [keys, setKeys] = useState({ asrApiKey: '', volcAppKey: '', volcAccessKey: '', polishApiKey: '' });
  const [status, setStatus] = useState('');
  useEffect(() => { void window.otto?.voiceGetConfig?.().then(setCfg).catch(() => undefined); }, []);
  const patch = (next: Partial<VoicePublicConfig>) => setCfg((v) => ({ ...v, ...next }));
  const save = async () => {
    setStatus('保存中…');
    try {
      const input: VoiceConfigInput = { ...cfg, ...keys };
      const saved = await window.otto.voiceSaveConfig(input);
      setCfg(saved);
      setKeys({ asrApiKey: '', volcAppKey: '', volcAccessKey: '', polishApiKey: '' });
      setStatus('已保存，可直接点击聊天框麦克风测试。');
    } catch (e) {
      setStatus(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <div className="otto-voice-settings">
      <button type="button" className="otto-setup__advanced-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <IconChevron size={13} className={open ? 'otto-setup__advanced-chev otto-setup__advanced-chev--open' : 'otto-setup__advanced-chev'} />
        语音输入
        {cfg.enabled ? <span className="otto-voice-settings__on">• 已启用</span> : null}
      </button>
      {open ? <div className="otto-voice-settings__body">
        <label className="otto-setup__toggleline"><input type="checkbox" checked={cfg.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />启用聊天框麦克风</label>
        <label className="otto-setup__label">语音识别</label>
        <select className="otto-setup__select" value={cfg.asrProvider} onChange={(e) => patch({ asrProvider: e.target.value as VoicePublicConfig['asrProvider'] })}>
          <option value="volcengine">火山引擎录音极速版</option><option value="openai">OpenAI-compatible</option>
        </select>
        <label className="otto-setup__label">识别接口地址</label>
        <input className="otto-setup__input" value={cfg.asrEndpoint} onChange={(e) => patch({ asrEndpoint: e.target.value })} />
        <label className="otto-setup__label">识别模型</label>
        <input className="otto-setup__input" value={cfg.asrModel} onChange={(e) => patch({ asrModel: e.target.value })} />
        {cfg.asrProvider === 'volcengine' ? <>
          <label className="otto-setup__label">App Key</label><input className="otto-setup__input" type="password" value={keys.volcAppKey} placeholder={cfg.hasVolcCredentials ? '留空保留当前凭证' : '火山 App Key'} onChange={(e) => setKeys((k) => ({ ...k, volcAppKey: e.target.value }))} />
          <label className="otto-setup__label">Access Key</label><input className="otto-setup__input" type="password" value={keys.volcAccessKey} placeholder={cfg.hasVolcCredentials ? '留空保留当前凭证' : '火山 Access Key'} onChange={(e) => setKeys((k) => ({ ...k, volcAccessKey: e.target.value }))} />
          <label className="otto-setup__label">Resource ID</label><input className="otto-setup__input" value={cfg.volcResourceId} onChange={(e) => patch({ volcResourceId: e.target.value })} />
        </> : <><label className="otto-setup__label">识别 API Key</label><input className="otto-setup__input" type="password" value={keys.asrApiKey} placeholder={cfg.hasAsrApiKey ? '留空保留当前 API Key' : 'API Key'} onChange={(e) => setKeys((k) => ({ ...k, asrApiKey: e.target.value }))} /></>}
        <label className="otto-setup__toggleline"><input type="checkbox" checked={cfg.polishEnabled} onChange={(e) => patch({ polishEnabled: e.target.checked })} />识别后自动润色</label>
        {cfg.polishEnabled ? <>
          <label className="otto-setup__label">润色接口</label><input className="otto-setup__input" value={cfg.polishEndpoint} onChange={(e) => patch({ polishEndpoint: e.target.value })} />
          <label className="otto-setup__label">润色模型</label><input className="otto-setup__input" value={cfg.polishModel} onChange={(e) => patch({ polishModel: e.target.value })} />
          <label className="otto-setup__label">润色 API Key</label><input className="otto-setup__input" type="password" value={keys.polishApiKey} placeholder={cfg.hasPolishApiKey ? '留空保留当前 API Key' : 'API Key'} onChange={(e) => setKeys((k) => ({ ...k, polishApiKey: e.target.value }))} />
          <label className="otto-setup__label">润色规则</label><textarea className="otto-setup__input otto-voice-settings__prompt" value={cfg.polishPrompt} onChange={(e) => patch({ polishPrompt: e.target.value })} />
        </> : null}
        <button type="button" className="otto-setup__btn otto-setup__btn--primary" onClick={() => void save()}>保存语音配置</button>
        {status ? <p className="otto-setup__hint" role="status">{status}</p> : null}
      </div> : null}
    </div>
  );
}
