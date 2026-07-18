/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「接入企业」面板（设置与诊断中心 · 账号与连接组）。
 *
 * 用户从企业服务器网页获得 6 位配对令牌后，在此面板输入以完成接入。
 * 与传统飞书接入不同：这里不需要反复填 appid/secret，只需一次配对。
 */

import React, { useState } from 'react';
import { Panel, Card } from './HubUI.js';

export function LocalAgentPanel(): React.JSX.Element {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    enterpriseUrl?: string;
  } | null>(null);

  const handlePair = async (): Promise<void> => {
    const trimmed = token.trim().toUpperCase();
    if (trimmed.length < 6) {
      setResult({ ok: false, message: '请输入完整的 6 位配对令牌' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await window.otto?.enterprisePair(trimmed);
      setResult(res ?? { ok: false, message: '接入服务未响应，请重试' });
    } catch (err) {
      setResult({
        ok: false,
        message: `接入失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !busy) void handlePair();
  };

  return (
    <Panel
      title="接入企业"
      desc="从企业服务器网页获得配对令牌，粘贴即可完成接入。"
    >
      {/* 状态卡片 */}
      <Card>
        <div className="otto-hub__row">
          <div className="otto-hub__row-left">
            <div className="otto-hub__row-title">企业服务器状态</div>
            <div className="otto-hub__row-desc">
              {result?.ok
                ? `已接入：${result.enterpriseUrl ?? '企业服务器'}`
                : result?.ok === false
                  ? `接入失败：${result.message}`
                  : '尚未接入企业服务器'}
            </div>
          </div>
          <div className="otto-hub__row-right">
            <span
              className={
                'otto-hub__badge' +
                (result?.ok ? ' otto-hub__badge--ok' : result ? ' otto-hub__badge--err' : ' otto-hub__badge--muted')
              }
            >
              {result?.ok ? '已连接' : result ? '失败' : '未接入'}
            </span>
          </div>
        </div>
      </Card>

      {/* 令牌输入 */}
      <div style={{ marginTop: 20 }}>
        <Card>
          <div style={{ padding: '8px 0' }}>
            <div className="otto-hub__field-label" style={{ marginBottom: 10 }}>
              配对令牌
            </div>
            <div className="otto-hub__field-hint" style={{ marginBottom: 14 }}>
              在企业服务器网页 <code>/enterprise/local-agent</code> 生成配对令牌后粘贴到这里。
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input
                type="text"
                className="otto-hub__input"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 6));
                  setResult(null);
                }}
                onKeyDown={handleKeyDown}
                placeholder="6 位令牌"
                maxLength={6}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                style={{
                  flex: 1,
                  minHeight: 44,
                  padding: '0 16px',
                  border: '1px solid #d9d6ca',
                  borderRadius: 12,
                  fontSize: 20,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontWeight: 800,
                  letterSpacing: '.15em',
                  textAlign: 'center',
                  textTransform: 'uppercase',
                  background: '#f7f5ef',
                  color: '#173f37',
                }}
              />
              <button
                type="button"
                className="otto-hub__btn-primary"
                onClick={() => void handlePair()}
                disabled={busy || token.trim().length < 6}
                style={{
                  minHeight: 44,
                  padding: '0 22px',
                  borderRadius: 12,
                  border: 'none',
                  background: token.trim().length >= 6 ? '#f1bd55' : '#e8e4d8',
                  color: token.trim().length >= 6 ? '#17352f' : '#a0a597',
                  fontSize: 15,
                  fontWeight: 800,
                  cursor: token.trim().length >= 6 && !busy ? 'pointer' : 'not-allowed',
                }}
              >
                {busy ? '接入中…' : '接入'}
              </button>
            </div>
          </div>
        </Card>
      </div>

      {/* 成功提示 */}
      {result?.ok ? (
        <div style={{ marginTop: 20 }}>
          <Card className="otto-prefs-simple">
            <div className="otto-prefs-simple__intro">
              <span className="otto-prefs-simple__check">✓</span>
              企业服务器接入成功！你的 Otto 现在可以与团队成员协作。
            </div>
          </Card>
        </div>
      ) : null}
    </Panel>
  );
}
