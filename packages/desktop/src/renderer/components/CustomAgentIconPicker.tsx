/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';

import {
  CUSTOM_AGENT_PRESET_ICONS,
  createUploadedCustomAgentIcon,
  customAgentIconToModuleIcon,
  type CustomAgentIcon,
} from '../customAgentIcons.js';
import { GeneratedIcon } from './GeneratedIcon.js';
import { ModuleIcon } from './ModuleIcon.js';

export function CustomAgentIconPicker({
  value,
  label,
  onChange,
}: {
  value?: CustomAgentIcon;
  label: string;
  onChange(icon: CustomAgentIcon): void | Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'preset' | 'upload'>('preset');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setTab('preset');
      setError('');
      setBusy(false);
    }
  }, [open]);

  const triggerLabel = label === '模块'
    ? '选择模块图标'
    : `更换${label}的图标`;

  const applyIcon = (icon: CustomAgentIcon): void => {
    setBusy(true);
    setError('');
    void Promise.resolve()
      .then(() => onChange(icon))
      .then(() => setOpen(false))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div className={`otto-custom-agent-icon-picker${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="otto-custom-agent-icon-picker__trigger"
        aria-label={triggerLabel}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ModuleIcon icon={customAgentIconToModuleIcon(value)} label={label} size={34} />
        <span>{value ? '更换图标' : '选择图标'}</span>
      </button>
      {open ? (
        <section className="otto-custom-agent-icon-picker__panel" aria-label="模块图标选择器">
          <div className="otto-custom-agent-icon-picker__tabs" role="tablist" aria-label="图标来源">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'preset'}
              onClick={() => setTab('preset')}
            >
              图标库
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'upload'}
              onClick={() => setTab('upload')}
            >
              上传图片
            </button>
          </div>
          {tab === 'preset' ? (
            <div className="otto-custom-agent-icon-picker__grid">
              {CUSTOM_AGENT_PRESET_ICONS.map((item) => {
                const selected = value?.kind === 'preset' && value.name === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={selected ? 'is-selected' : undefined}
                    aria-label={`选择图标：${item.label}`}
                    aria-pressed={selected}
                    title={item.label}
                    disabled={busy}
                    onClick={() => applyIcon({ kind: 'preset', name: item.id })}
                  >
                    <GeneratedIcon name={item.id} size={32} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="otto-custom-agent-icon-picker__upload">
              <label>
                <span>{busy ? '正在处理图片…' : '选择本地图片'}</span>
                <input
                  type="file"
                  aria-label="选择本地图片"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (!file) return;
                    setBusy(true);
                    setError('');
                    void createUploadedCustomAgentIcon(file)
                      .then((icon) => onChange(icon))
                      .then(() => setOpen(false))
                      .catch((cause) => {
                        setError(cause instanceof Error ? cause.message : String(cause));
                      })
                      .finally(() => setBusy(false));
                  }}
                />
              </label>
              <p>支持 PNG、JPEG、WebP，最大 5MB；图片会自动居中裁切并压缩。</p>
            </div>
          )}
          {error ? <p role="alert" className="otto-workspace-dialog__error">{error}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
