/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import type { EnterpriseDataGovernanceProfile } from '../../../preload/index.js';
import { Badge, Card, Empty, Panel } from './HubUI.js';

function licenseLabel(status: string): { text: string; danger: boolean } {
  if (status === 'active') return { text: '授权有效', danger: false };
  if (status === 'expiring') return { text: '授权即将到期', danger: true };
  if (status === 'missing' || status === 'invalid') return { text: '未配置正式授权', danger: true };
  return { text: '授权受限', danger: true };
}

function storageLabel(storage: EnterpriseDataGovernanceProfile['processingActivities'][number]['storage']): string {
  if (storage === 'user_device') return '用户电脑 / 加密同步快照';
  if (storage === 'configured_provider') return '客户配置的模型供应商';
  return '当前企业服务器';
}

export function PrivacyDataPanel(): React.JSX.Element {
  const [profile, setProfile] = useState<EnterpriseDataGovernanceProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showDelete, setShowDelete] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const load = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      setProfile(await window.otto.enterpriseDataGovernanceGet());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const accept = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      setProfile(await window.otto.enterpriseLegalAccept());
      setNotice('当前版本的用户协议与隐私规则已记录。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportData = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const result = await window.otto.enterprisePrivacyExport();
      if (result) setNotice(`个人数据已导出到 ${result.path}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await window.otto.enterprisePrivacyDelete({ password, confirmation });
      setNotice('账号已注销，本机托管的个人记忆、工作日志和自动 Skill 已清理。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const openLegal = (): void => {
    const base = window.location.origin;
    void window.otto.enterpriseSession().then((session) => {
      if (session.serverUrl) void window.otto.openExternal(`${session.serverUrl.replace(/\/+$/u, '')}/enterprise/legal`);
      else setError(`无法确定企业服务器地址（当前页面 ${base}）`);
    });
  };

  const license = profile ? licenseLabel(profile.authorization.license.status) : null;
  return (
    <Panel
      title="隐私与数据"
      desc="查看授权、数据位置、处理边界，并管理你自己的数据。"
      actions={<button type="button" className="otto-hub__btn" disabled={busy} onClick={() => void load()}>刷新</button>}
    >
      {error ? <div className="otto-hub__privacy-error" role="alert">{error}</div> : null}
      {notice ? <div className="otto-hub__privacy-notice" role="status">{notice}</div> : null}
      {!profile ? <Empty>{busy ? '正在读取企业数据规则…' : '暂时无法读取数据规则'}</Empty> : (
        <>
          <Card className="otto-hub__privacy-summary">
            <div><span>License</span><strong>{license?.text}</strong><Badge tone={license?.danger ? 'danger' : 'accent'}>{profile.authorization.license.plan}</Badge></div>
            <div><span>数据位置</span><strong>{profile.residency.localizationReady ? '中国境内 / 当前企业服务器' : profile.residency.region}</strong><small>{profile.residency.crossBorderEnabled ? '已开启跨境处理' : '默认不跨境'}</small></div>
            <div><span>健康遥测</span><strong>{profile.authorization.telemetry.enabled ? '已开启' : '已关闭'}</strong><small>不上传聊天、文件、会议或个人记忆原文</small></div>
            <div><span>传输</span><strong>公网 HTTPS / TLS</strong><small>会话令牌不进入 URL</small></div>
          </Card>

          {!profile.readiness.configured ? (
            <div className="otto-hub__privacy-warning">
              部署管理员尚未完整配置个人信息处理者名称或隐私联系方式：{profile.readiness.warnings.join('；')}
            </div>
          ) : null}

          <div className="otto-hub__privacy-section-head">
            <div><strong>协议与处理者</strong><span>{profile.controller.name} · {profile.controller.privacyContact}</span></div>
            <button type="button" className="otto-hub__btn" onClick={openLegal}>查看完整规则</button>
          </div>
          <Card>
            {profile.documents.map((document) => (
              <div className="otto-hub__setting" key={document.id}>
                <div className="otto-hub__setting-text">
                  <strong>{document.title}</strong>
                  <span className="otto-hub__field-hint">版本 {document.version} · {document.accepted ? '已同意' : '待同意'}</span>
                </div>
                <Badge tone={document.accepted ? 'accent' : 'danger'}>{document.accepted ? '已记录' : '未记录'}</Badge>
              </div>
            ))}
            {!profile.currentConsentComplete ? (
              <div className="otto-hub__setting">
                <div className="otto-hub__setting-text"><strong>需要确认当前协议版本</strong><span className="otto-hub__field-hint">同意记录包含版本、哈希和时间，不记录额外内容。</span></div>
                <button type="button" className="otto-hub__btn otto-hub__btn--primary" disabled={busy} onClick={() => void accept()}>同意当前版本</button>
              </div>
            ) : null}
          </Card>

          <div className="otto-hub__privacy-section-head"><div><strong>数据处理目录</strong><span>每类数据的用途、位置、加密、留存和删除方式</span></div></div>
          <div className="otto-hub__privacy-activities">
            {profile.processingActivities.map((activity) => (
              <details key={activity.id}>
                <summary><span><strong>{activity.category}</strong><small>{activity.purpose}</small></span><Badge>{storageLabel(activity.storage)}</Badge></summary>
                <dl>
                  <div><dt>静态保护</dt><dd>{activity.atRest}</dd></div>
                  <div><dt>传输协议</dt><dd>{activity.transport}</dd></div>
                  <div><dt>留存期限</dt><dd>{activity.retention}</dd></div>
                  <div><dt>注销处理</dt><dd>{activity.deletion}</dd></div>
                  <div><dt>接收方</dt><dd>{activity.recipients.join('、')}</dd></div>
                </dl>
              </details>
            ))}
          </div>

          <div className="otto-hub__privacy-section-head"><div><strong>我的数据权利</strong><span>导出不会修改数据，注销不可撤销。</span></div></div>
          <Card>
            <div className="otto-hub__setting">
              <div className="otto-hub__setting-text"><strong>导出我的数据</strong><span className="otto-hub__field-hint">生成 JSON 文件，包含账号资料、记忆同步元数据、工作日志、私聊、用量和园区申请。</span></div>
              <button type="button" className="otto-hub__btn" disabled={busy} onClick={() => void exportData()}>导出</button>
            </div>
            <div className="otto-hub__setting otto-hub__setting--stack">
              <div className="otto-hub__setting-text"><strong>注销账号</strong><span className="otto-hub__field-hint">清除可删除的个人数据；财务、匿名园区统计和安全日志按法定义务最小保留。企业最后一名管理员需先移交权限。</span></div>
              {!showDelete ? (
                <button type="button" className="otto-hub__btn otto-hub__btn--danger" onClick={() => setShowDelete(true)}>开始注销</button>
              ) : (
                <div className="otto-hub__privacy-delete">
                  <input className="otto-hub__input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入当前登录密码" />
                  <input className="otto-hub__input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="输入：注销我的 Otto 账号" />
                  <button type="button" className="otto-hub__btn otto-hub__btn--danger" disabled={busy || !password || confirmation !== '注销我的 Otto 账号'} onClick={() => void deleteAccount()}>确认永久注销</button>
                  <button type="button" className="otto-hub__btn" disabled={busy} onClick={() => { setShowDelete(false); setPassword(''); setConfirmation(''); }}>取消</button>
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </Panel>
  );
}
