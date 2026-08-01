/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';

import type {
  EnterpriseE2eeDeviceSummary,
  EnterpriseE2eeDeviceVerification,
  EnterpriseE2eeTrustOverview,
} from '../../../preload/index.js';
import { createQrMatrix } from '../../lib/qrMatrix.js';
import { Badge, Card, Empty } from './HubUI.js';

function stateLabel(state: EnterpriseE2eeDeviceSummary['state'] | 'not_registered'): string {
  if (state === 'approved') return '已批准';
  if (state === 'pending') return '待批准';
  if (state === 'revoked') return '已撤销';
  if (state === 'expired') return '已过期';
  return '未注册';
}

function stateTone(
  state: EnterpriseE2eeDeviceSummary['state'] | 'not_registered',
): 'accent' | 'danger' | undefined {
  if (state === 'approved') return 'accent';
  if (state === 'revoked' || state === 'expired') return 'danger';
  return undefined;
}

function shortFingerprint(value: string): string {
  return value.match(/.{1,4}/gu)?.slice(0, 8).join(' ') ?? value;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function VerificationQr({ payload }: { payload: string }): React.JSX.Element | null {
  const matrix = createQrMatrix(payload);
  if (!matrix) return null;
  const path = matrix
    .flatMap((row, y) =>
      row.flatMap((filled, x) => (filled ? [`M${x} ${y}h1v1h-1z`] : [])))
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

export function E2eeDeviceSecurityCard(): React.JSX.Element {
  const [overview, setOverview] = useState<EnterpriseE2eeTrustOverview | null>(null);
  const [verification, setVerification] = useState<EnterpriseE2eeDeviceVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revokeDeviceId, setRevokeDeviceId] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      setOverview(await window.otto.enterpriseE2eeTrustOverview());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const inspect = async (device: EnterpriseE2eeDeviceSummary): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      setVerification(await window.otto.enterpriseE2eeDeviceVerification(device.deviceId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const approve = async (deviceId: string): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const next = await window.otto.enterpriseE2eeDeviceApprove(deviceId);
      setOverview(next);
      setVerification(null);
      setNotice('新设备已批准。它只会在消息加密正式启用后接收后续会话密钥。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (deviceId: string): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const next = await window.otto.enterpriseE2eeDeviceRevoke(deviceId);
      setOverview(next);
      setRevokeDeviceId(null);
      setVerification(null);
      setNotice('设备已撤销。后续消息密钥不会再分发给该设备。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="otto-hub__privacy-section-head">
        <div>
          <strong>E2EE 设备安全</strong>
          <span>私钥由本机系统安全存储保护，企业服务器不能替你批准设备</span>
        </div>
        <button type="button" className="otto-hub__btn" disabled={busy} onClick={() => void load()}>
          刷新设备
        </button>
      </div>

      {error ? <div className="otto-hub__privacy-error" role="alert">{error}</div> : null}
      {notice ? <div className="otto-hub__privacy-notice" role="status">{notice}</div> : null}

      {!overview ? <Empty>{busy ? '正在验证设备信任目录…' : '暂时无法读取设备安全状态'}</Empty> : (
        <>
          <div className="otto-hub__e2ee-release-state">
            <div>
              <strong>{overview.capability.enabled ? '消息端到端加密已启用' : '设备信任基础已准备'}</strong>
              <span>
                {overview.capability.enabled
                  ? '聊天窗口会显示每个会话的核验状态。'
                  : '当前仍未启用消息加密，也不会把明文聊天伪装为 E2EE。'}
              </span>
            </div>
            <Badge tone={overview.capability.enabled ? 'accent' : undefined}>
              {overview.capability.releaseState}
            </Badge>
          </div>

          {!overview.secureStorage.available ? (
            <div className="otto-hub__privacy-error" role="alert">
              系统安全存储不可用，Otto 已停止创建和使用 E2EE 私钥。请先修复系统密钥库。
            </div>
          ) : (
            <Card className="otto-hub__e2ee-card">
              <div className="otto-hub__e2ee-local">
                <div>
                  <span className="otto-hub__e2ee-kicker">当前设备</span>
                  <strong>{overview.localDevice?.deviceName ?? '尚未建立本机设备身份'}</strong>
                  <small>{overview.secureStorage.backend}</small>
                </div>
                {overview.localDevice ? (
                  <div className="otto-hub__e2ee-local-meta">
                    <Badge tone={stateTone(overview.localDevice.registrationState)}>
                      {stateLabel(overview.localDevice.registrationState)}
                    </Badge>
                    <code>{shortFingerprint(overview.localDevice.publicKeyFingerprint)}</code>
                  </div>
                ) : null}
              </div>

              {overview.directoryState === 'not_initialized' ? (
                <Empty>
                  账号尚未建立设备信任目录。OpenMLS 内核接入后会使用真实 KeyPackage 注册；当前版本不会生成占位密钥。
                </Empty>
              ) : (
                <div className="otto-hub__e2ee-devices">
                  {overview.devices.map((device) => (
                    <div className="otto-hub__e2ee-device" key={device.deviceId}>
                      <div className="otto-hub__e2ee-device-main">
                        <div className="otto-hub__e2ee-device-title">
                          <strong>{device.deviceName}</strong>
                          {device.isCurrentDevice ? <Badge tone="accent">本机</Badge> : null}
                          <Badge tone={stateTone(device.state)}>{stateLabel(device.state)}</Badge>
                        </div>
                        <span>登记于 {formatDate(device.issuedAt)} · 凭据序号 {device.transparencySequence}</span>
                        <code>{shortFingerprint(device.credentialFingerprint)}</code>
                      </div>
                      <div className="otto-hub__e2ee-device-actions">
                        {overview.canManageDevices ? (
                          <button type="button" className="otto-hub__btn" disabled={busy} onClick={() => void inspect(device)}>
                            核验
                          </button>
                        ) : null}
                        {overview.canManageDevices && device.state === 'approved' && !device.isCurrentDevice ? (
                          revokeDeviceId === device.deviceId ? (
                            <>
                              <button type="button" className="otto-hub__btn otto-hub__btn--danger" disabled={busy} onClick={() => void revoke(device.deviceId)}>
                                确认撤销
                              </button>
                              <button type="button" className="otto-hub__btn" disabled={busy} onClick={() => setRevokeDeviceId(null)}>
                                取消
                              </button>
                            </>
                          ) : (
                            <button type="button" className="otto-hub__btn otto-hub__btn--danger" disabled={busy} onClick={() => setRevokeDeviceId(device.deviceId)}>
                              撤销
                            </button>
                          )
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          {overview.transparency ? (
            <div className="otto-hub__e2ee-checkpoint">
              <span>透明日志已在本机固定</span>
              <code>{overview.transparency.size} · {shortFingerprint(overview.transparency.rootHash)}</code>
              <small>{formatDate(overview.transparency.pinnedAt)}</small>
            </div>
          ) : null}

          {verification ? (
            <div className="otto-hub__e2ee-verification" role="dialog" aria-label="核验 E2EE 设备">
              <VerificationQr payload={verification.qrPayload} />
              <div className="otto-hub__e2ee-verification-copy">
                <span className="otto-hub__e2ee-kicker">核验 {verification.deviceName}</span>
                <strong>请通过当面、电话等独立渠道比较安全号码</strong>
                <code>{verification.safetyNumber}</code>
                <small>二维码和数字只包含公开凭据指纹，不包含私钥或聊天内容。</small>
                <div className="otto-hub__e2ee-verification-actions">
                  {overview.devices.find((device) => device.deviceId === verification.deviceId)?.state === 'pending' ? (
                    <button type="button" className="otto-hub__btn otto-hub__btn--primary" disabled={busy} onClick={() => void approve(verification.deviceId)}>
                      核验无误并批准
                    </button>
                  ) : null}
                  <button type="button" className="otto-hub__btn" disabled={busy} onClick={() => setVerification(null)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
