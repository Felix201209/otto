/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import type {
  EnterpriseDataGovernanceProfile,
  EnterpriseE2eeDevice,
  EnterpriseE2eeDeviceVerification,
  EnterpriseE2eeKeyTransparencyEvent,
  EnterpriseE2eeKeyTransparencyView,
} from '../../../preload/index.js';
import { createQrMatrix } from '../../lib/qrMatrix.js';
import { Badge, Card, Empty, Panel } from './HubUI.js';

function DeviceVerificationQr({
  payload,
}: {
  payload: string;
}): React.JSX.Element | null {
  const matrix = createQrMatrix(payload);
  if (!matrix) return null;
  const path = matrix
    .flatMap((row, y) =>
      row.flatMap((filled, x) => (filled ? [`M${x} ${y}h1v1h-1z`] : [])),
    )
    .join('');
  const size = matrix.length;
  return (
    <svg
      className="otto-hub__e2ee-qr"
      role="img"
      aria-label="设备安全号码二维码"
      viewBox={`-3 -3 ${size + 6} ${size + 6}`}
      shapeRendering="crispEdges"
    >
      <rect x={-3} y={-3} width={size + 6} height={size + 6} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}

function licenseLabel(status: string): { text: string; danger: boolean } {
  if (status === 'active') return { text: '授权有效', danger: false };
  if (status === 'expiring') return { text: '授权即将到期', danger: true };
  if (status === 'missing' || status === 'invalid')
    return { text: '未配置正式授权', danger: true };
  return { text: '授权受限', danger: true };
}

function storageLabel(
  storage: EnterpriseDataGovernanceProfile['processingActivities'][number]['storage'],
): string {
  if (storage === 'user_device') return '用户电脑 / 加密同步快照';
  if (storage === 'configured_provider') return '客户配置的模型供应商';
  return '当前企业服务器';
}

function transparencyEventLabel(
  event: EnterpriseE2eeKeyTransparencyEvent,
): string {
  if (event === 'bootstrap_approved') return '首台设备建立';
  if (event === 'registered_pending') return '新设备待批准';
  if (event === 'approved') return '设备已批准';
  return '设备已撤销';
}

export function PrivacyDataPanel(): React.JSX.Element {
  const [profile, setProfile] =
    useState<EnterpriseDataGovernanceProfile | null>(null);
  const [devices, setDevices] = useState<EnterpriseE2eeDevice[] | null>(null);
  const [transparency, setTransparency] =
    useState<EnterpriseE2eeKeyTransparencyView | null>(null);
  const [busy, setBusy] = useState(false);
  const [e2eeBusy, setE2eeBusy] = useState(false);
  const [error, setError] = useState('');
  const [e2eeError, setE2eeError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingDeviceRevocation, setPendingDeviceRevocation] = useState<
    string | null
  >(null);
  const [deviceVerification, setDeviceVerification] = useState<{
    deviceId: string;
    value: EnterpriseE2eeDeviceVerification;
  } | null>(null);
  const [recoveryPassphrase, setRecoveryPassphrase] = useState('');
  const [recoveryPassphraseConfirmation, setRecoveryPassphraseConfirmation] =
    useState('');
  const [recoveryBundle, setRecoveryBundle] = useState('');
  const [recoveryImportPassphrase, setRecoveryImportPassphrase] = useState('');
  const [showDelete, setShowDelete] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const load = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setE2eeError('');
    try {
      setProfile(await window.otto.enterpriseDataGovernanceGet());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    try {
      setDevices(await window.otto.enterpriseE2eeDevicesList());
      setTransparency(await window.otto.enterpriseE2eeKeyTransparency());
    } catch (cause) {
      setE2eeError(cause instanceof Error ? cause.message : String(cause));
    }
    setBusy(false);
  };

  useEffect(() => {
    void load();
  }, []);

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
      setNotice(
        '账号已注销，本机托管的个人记忆、工作日志和自动 Skill 已清理。',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  const openLegal = (): void => {
    const base = window.location.origin;
    void window.otto.enterpriseSession().then((session) => {
      if (session.serverUrl)
        void window.otto.openExternal(
          `${session.serverUrl.replace(/\/+$/u, '')}/enterprise/legal`,
        );
      else setError(`无法确定企业服务器地址（当前页面 ${base}）`);
    });
  };

  const revokeDevice = async (device: EnterpriseE2eeDevice): Promise<void> => {
    setE2eeBusy(true);
    setE2eeError('');
    try {
      await window.otto.enterpriseE2eeDeviceRevoke(device.deviceId);
      setDevices(await window.otto.enterpriseE2eeDevicesList());
      setTransparency(await window.otto.enterpriseE2eeKeyTransparency());
      setPendingDeviceRevocation(null);
      setNotice(`已撤销设备“${device.deviceName}”；它不能再接收新消息密钥。`);
    } catch (cause) {
      setE2eeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setE2eeBusy(false);
    }
  };

  const inspectDevice = async (device: EnterpriseE2eeDevice): Promise<void> => {
    setE2eeBusy(true);
    setE2eeError('');
    try {
      const value = await window.otto.enterpriseE2eeDeviceVerification(
        device.deviceId,
      );
      setDeviceVerification({ deviceId: device.deviceId, value });
    } catch (cause) {
      setE2eeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setE2eeBusy(false);
    }
  };

  const approveDevice = async (device: EnterpriseE2eeDevice): Promise<void> => {
    setE2eeBusy(true);
    setE2eeError('');
    try {
      await window.otto.enterpriseE2eeDeviceApprove(device.deviceId);
      setDevices(await window.otto.enterpriseE2eeDevicesList());
      setTransparency(await window.otto.enterpriseE2eeKeyTransparency());
      setDeviceVerification(null);
      setNotice(
        `已批准设备“${device.deviceName}”；后续消息会包含该设备的密钥信封。`,
      );
    } catch (cause) {
      setE2eeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setE2eeBusy(false);
    }
  };

  const exportRecoveryBundle = async (): Promise<void> => {
    if (recoveryPassphrase.length < 12) {
      setE2eeError('恢复包口令至少需要 12 个字符。');
      return;
    }
    if (recoveryPassphrase !== recoveryPassphraseConfirmation) {
      setE2eeError('两次输入的恢复包口令不一致。');
      return;
    }
    setE2eeBusy(true);
    setE2eeError('');
    try {
      const bundle =
        await window.otto.enterpriseE2eeRecoveryExport(recoveryPassphrase);
      const date = new Date().toISOString().slice(0, 10);
      const savedPath = await window.otto.saveTextFile(
        `otto-e2ee-recovery-${date}.json`,
        bundle,
      );
      if (savedPath) {
        setNotice(`恢复包已保存到 ${savedPath}`);
        setRecoveryPassphrase('');
        setRecoveryPassphraseConfirmation('');
      }
    } catch (cause) {
      setE2eeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setE2eeBusy(false);
    }
  };

  const importRecoveryBundle = async (): Promise<void> => {
    if (!recoveryBundle.trim() || recoveryImportPassphrase.length < 12) {
      setE2eeError('请粘贴恢复包，并输入至少 12 个字符的恢复口令。');
      return;
    }
    setE2eeBusy(true);
    setE2eeError('');
    try {
      await window.otto.enterpriseE2eeRecoveryImport(
        recoveryBundle.trim(),
        recoveryImportPassphrase,
      );
      setRecoveryBundle('');
      setRecoveryImportPassphrase('');
      setNotice('历史设备密钥已安全导入；当前设备密钥保持不变。');
    } catch (cause) {
      setE2eeError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setE2eeBusy(false);
    }
  };

  const license = profile
    ? licenseLabel(profile.authorization.license.status)
    : null;
  return (
    <Panel
      title="隐私与数据"
      desc="查看授权、数据位置、处理边界，并管理你自己的数据。"
      actions={
        <button
          type="button"
          className="otto-hub__btn"
          disabled={busy}
          onClick={() => void load()}
        >
          刷新
        </button>
      }
    >
      {error ? (
        <div className="otto-hub__privacy-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="otto-hub__privacy-notice" role="status">
          {notice}
        </div>
      ) : null}
      {!profile ? (
        <Empty>{busy ? '正在读取企业数据规则…' : '暂时无法读取数据规则'}</Empty>
      ) : (
        <>
          <Card className="otto-hub__privacy-summary">
            <div>
              <span>许可证</span>
              <strong>{license?.text}</strong>
              <Badge tone={license?.danger ? 'danger' : 'accent'}>
                {profile.authorization.license.plan}
              </Badge>
            </div>
            <div>
              <span>数据位置</span>
              <strong>
                {profile.residency.localizationReady
                  ? '中国境内 / 当前企业服务器'
                  : profile.residency.region}
              </strong>
              <small>
                {profile.residency.crossBorderEnabled
                  ? '已开启跨境处理'
                  : '默认不跨境'}
              </small>
            </div>
            <div>
              <span>健康遥测</span>
              <strong>
                {profile.authorization.telemetry.enabled ? '已开启' : '已关闭'}
              </strong>
              <small>不上传聊天、文件、会议或个人记忆原文</small>
            </div>
            <div>
              <span>传输</span>
              <strong>公网 HTTPS / TLS</strong>
              <small>会话令牌不进入 URL</small>
            </div>
          </Card>

          <div className="otto-hub__privacy-section-head">
            <div>
              <strong>端到端加密私聊</strong>
              <span>消息与附件只在已登记设备上解密；服务器只保存密文。</span>
            </div>
          </div>
          {e2eeError ? (
            <div className="otto-hub__privacy-error" role="alert">
              {e2eeError}
            </div>
          ) : null}
          <Card className="otto-hub__e2ee-card">
            <div className="otto-hub__e2ee-device-list">
              {!devices ? (
                <Empty>
                  {busy ? '正在读取加密设备…' : '暂时无法读取加密设备'}
                </Empty>
              ) : null}
              {devices?.length === 0 ? (
                <Empty>还没有登记的加密设备</Empty>
              ) : null}
              {devices?.map((device) => (
                <div className="otto-hub__e2ee-device" key={device.deviceId}>
                  <div>
                    <strong>{device.deviceName}</strong>
                    <span>
                      设备 {device.deviceId.slice(0, 12)} · 指纹{' '}
                      {device.keyFingerprint?.slice(0, 16)} · 最后在线{' '}
                      {new Date(device.lastSeenAt).toLocaleString()}
                    </span>
                  </div>
                  <Badge
                    tone={
                      device.revokedAt || device.approvalState === 'pending'
                        ? 'danger'
                        : 'accent'
                    }
                  >
                    {device.revokedAt
                      ? '已撤销'
                      : device.approvalState === 'pending'
                        ? '等待批准'
                        : '可接收新消息'}
                  </Badge>
                  {!device.revokedAt &&
                  device.approvalState === 'pending' &&
                  !device.isCurrentDevice ? (
                    <button
                      type="button"
                      className="otto-hub__btn"
                      disabled={e2eeBusy}
                      onClick={() => void inspectDevice(device)}
                    >
                      核验并批准
                    </button>
                  ) : null}
                  {!device.revokedAt ? (
                    pendingDeviceRevocation === device.deviceId ? (
                      <div className="otto-hub__e2ee-confirm">
                        <button
                          type="button"
                          className="otto-hub__btn otto-hub__btn--danger"
                          aria-label={`确认撤销 ${device.deviceName}`}
                          disabled={e2eeBusy}
                          onClick={() => void revokeDevice(device)}
                        >
                          确认撤销
                        </button>
                        <button
                          type="button"
                          className="otto-hub__btn"
                          disabled={e2eeBusy}
                          onClick={() => setPendingDeviceRevocation(null)}
                        >
                          取消
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="otto-hub__btn"
                        aria-label={`撤销设备 ${device.deviceName}`}
                        disabled={e2eeBusy}
                        onClick={() =>
                          setPendingDeviceRevocation(device.deviceId)
                        }
                      >
                        撤销设备
                      </button>
                    )
                  ) : null}
                  {deviceVerification?.deviceId === device.deviceId ? (
                    <div className="otto-hub__e2ee-verification">
                      <DeviceVerificationQr
                        payload={deviceVerification.value.qrPayload}
                      />
                      <div>
                        <strong>安全号码</strong>
                        <code>{deviceVerification.value.safetyNumber}</code>
                        <span>
                          请通过电话或当面核对号码/二维码；不要只信任企业服务器中显示的设备目录。
                        </span>
                        <button
                          type="button"
                          className="otto-hub__btn"
                          disabled={e2eeBusy}
                          onClick={() => void approveDevice(device)}
                        >
                          号码一致，批准设备
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="otto-hub__e2ee-recovery">
              <div className="otto-hub__setting-text">
                <strong>加密密钥恢复包</strong>
                <span className="otto-hub__field-hint">
                  恢复包由口令加密，但仍应保存在离线或受保护的位置。导入只补回历史解密密钥，不替换当前设备身份。
                </span>
              </div>
              <div className="otto-hub__e2ee-recovery-grid">
                <input
                  className="otto-hub__input"
                  type="password"
                  autoComplete="new-password"
                  aria-label="恢复包口令"
                  value={recoveryPassphrase}
                  onChange={(event) =>
                    setRecoveryPassphrase(event.target.value)
                  }
                  placeholder="设置至少 12 个字符的口令"
                />
                <input
                  className="otto-hub__input"
                  type="password"
                  autoComplete="new-password"
                  aria-label="确认恢复包口令"
                  value={recoveryPassphraseConfirmation}
                  onChange={(event) =>
                    setRecoveryPassphraseConfirmation(event.target.value)
                  }
                  placeholder="再次输入口令"
                />
                <button
                  type="button"
                  className="otto-hub__btn otto-hub__btn--primary"
                  disabled={e2eeBusy}
                  onClick={() => void exportRecoveryBundle()}
                >
                  导出恢复包
                </button>
              </div>
              <div className="otto-hub__e2ee-recovery-grid otto-hub__e2ee-recovery-grid--import">
                <textarea
                  className="otto-hub__input"
                  aria-label="恢复包内容"
                  value={recoveryBundle}
                  onChange={(event) => setRecoveryBundle(event.target.value)}
                  placeholder="粘贴恢复包 JSON"
                />
                <input
                  className="otto-hub__input"
                  type="password"
                  autoComplete="current-password"
                  aria-label="导入恢复包口令"
                  value={recoveryImportPassphrase}
                  onChange={(event) =>
                    setRecoveryImportPassphrase(event.target.value)
                  }
                  placeholder="输入恢复包口令"
                />
                <button
                  type="button"
                  className="otto-hub__btn"
                  disabled={e2eeBusy}
                  onClick={() => void importRecoveryBundle()}
                >
                  导入恢复包
                </button>
              </div>
            </div>
            <div className="otto-hub__e2ee-transparency">
              <div className="otto-hub__setting-text">
                <strong>密钥透明日志</strong>
                <span className="otto-hub__field-hint">
                  追加式记录设备登记、批准与撤销。在不同已核验设备间对比链头，可辅助发现目录回滚。
                </span>
              </div>
              {transparency ? (
                <>
                  <div className="otto-hub__e2ee-chain-head">
                    <Badge tone="accent">链头序号 {transparency.headSequence}</Badge>
                    <code title={transparency.headHash}>
                      {transparency.headHash.slice(0, 24)}
                    </code>
                  </div>
                  <div className="otto-hub__e2ee-log" role="list">
                    {transparency.entries.map((entry) => (
                      <div
                        className="otto-hub__e2ee-log-entry"
                        key={`${entry.sequence}:${entry.entryHash}`}
                        role="listitem"
                      >
                        <div>
                          <strong>{transparencyEventLabel(entry.event)}</strong>
                          <span>
                            序号 {entry.sequence} · 设备{' '}
                            {entry.deviceId.slice(0, 12)} · 指纹{' '}
                            {entry.keyFingerprint.slice(0, 16)} · 日志哈希{' '}
                            {entry.entryHash.slice(0, 16)}
                          </span>
                        </div>
                        <time dateTime={entry.createdAt}>
                          {new Date(entry.createdAt).toLocaleString()}
                        </time>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <Empty>{busy ? '正在读取透明日志…' : '暂时无法读取透明日志'}</Empty>
              )}
            </div>
          </Card>

          {!profile.readiness.configured ? (
            <div className="otto-hub__privacy-warning">
              部署管理员尚未完整配置个人信息处理者名称或隐私联系方式：
              {profile.readiness.warnings.join('；')}
            </div>
          ) : null}

          <div className="otto-hub__privacy-section-head">
            <div>
              <strong>协议与处理者</strong>
              <span>
                {profile.controller.name} · {profile.controller.privacyContact}
              </span>
            </div>
            <button type="button" className="otto-hub__btn" onClick={openLegal}>
              查看完整规则
            </button>
          </div>
          <Card>
            {profile.documents.map((document) => (
              <div className="otto-hub__setting" key={document.id}>
                <div className="otto-hub__setting-text">
                  <strong>{document.title}</strong>
                  <span className="otto-hub__field-hint">
                    版本 {document.version} ·{' '}
                    {document.accepted ? '已同意' : '待同意'}
                  </span>
                </div>
                <Badge tone={document.accepted ? 'accent' : 'danger'}>
                  {document.accepted ? '已记录' : '未记录'}
                </Badge>
              </div>
            ))}
            {!profile.currentConsentComplete ? (
              <div className="otto-hub__setting">
                <div className="otto-hub__setting-text">
                  <strong>需要确认当前协议版本</strong>
                  <span className="otto-hub__field-hint">
                    同意记录包含版本、哈希和时间，不记录额外内容。
                  </span>
                </div>
                <button
                  type="button"
                  className="otto-hub__btn otto-hub__btn--primary"
                  disabled={busy}
                  onClick={() => void accept()}
                >
                  同意当前版本
                </button>
              </div>
            ) : null}
          </Card>

          <div className="otto-hub__privacy-section-head">
            <div>
              <strong>数据处理目录</strong>
              <span>每类数据的用途、位置、加密、留存和删除方式</span>
            </div>
          </div>
          <div className="otto-hub__privacy-activities">
            {profile.processingActivities.map((activity) => (
              <details key={activity.id}>
                <summary>
                  <span>
                    <strong>{activity.category}</strong>
                    <small>{activity.purpose}</small>
                  </span>
                  <Badge>{storageLabel(activity.storage)}</Badge>
                </summary>
                <dl>
                  <div>
                    <dt>静态保护</dt>
                    <dd>{activity.atRest}</dd>
                  </div>
                  <div>
                    <dt>传输协议</dt>
                    <dd>{activity.transport}</dd>
                  </div>
                  <div>
                    <dt>留存期限</dt>
                    <dd>{activity.retention}</dd>
                  </div>
                  <div>
                    <dt>注销处理</dt>
                    <dd>{activity.deletion}</dd>
                  </div>
                  <div>
                    <dt>接收方</dt>
                    <dd>{activity.recipients.join('、')}</dd>
                  </div>
                </dl>
              </details>
            ))}
          </div>

          <div className="otto-hub__privacy-section-head">
            <div>
              <strong>我的数据权利</strong>
              <span>导出不会修改数据，注销不可撤销。</span>
            </div>
          </div>
          <Card>
            <div className="otto-hub__setting">
              <div className="otto-hub__setting-text">
                <strong>导出我的数据</strong>
                <span className="otto-hub__field-hint">
                  生成 JSON
                  文件，包含账号资料、记忆同步元数据、工作日志、私聊、用量和园区申请。
                </span>
              </div>
              <button
                type="button"
                className="otto-hub__btn"
                disabled={busy}
                onClick={() => void exportData()}
              >
                导出
              </button>
            </div>
            <div className="otto-hub__setting otto-hub__setting--stack">
              <div className="otto-hub__setting-text">
                <strong>注销账号</strong>
                <span className="otto-hub__field-hint">
                  清除可删除的个人数据；财务、匿名园区统计和安全日志按法定义务最小保留。企业最后一名管理员需先移交权限。
                </span>
              </div>
              {!showDelete ? (
                <button
                  type="button"
                  className="otto-hub__btn otto-hub__btn--danger"
                  onClick={() => setShowDelete(true)}
                >
                  开始注销
                </button>
              ) : (
                <div className="otto-hub__privacy-delete">
                  <input
                    className="otto-hub__input"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="输入当前登录密码"
                  />
                  <input
                    className="otto-hub__input"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    placeholder="输入：注销我的 Otto 账号"
                  />
                  <button
                    type="button"
                    className="otto-hub__btn otto-hub__btn--danger"
                    disabled={
                      busy || !password || confirmation !== '注销我的 Otto 账号'
                    }
                    onClick={() => void deleteAccount()}
                  >
                    确认永久注销
                  </button>
                  <button
                    type="button"
                    className="otto-hub__btn"
                    disabled={busy}
                    onClick={() => {
                      setShowDelete(false);
                      setPassword('');
                      setConfirmation('');
                    }}
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          </Card>
        </>
      )}
    </Panel>
  );
}
