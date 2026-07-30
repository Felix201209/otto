/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 *
 * 中心企业真实管理面板：所有写操作都经过 preload IPC 到企业服务器，不保存
 * 另一份 renderer 本地组织状态。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  EnterpriseAccount,
  EnterpriseOrganizationDepartment,
  EnterpriseOrganizationFeatures,
  EnterprisePark,
  EnterpriseParkInvite,
  EnterpriseParkService,
  EnterpriseParkSpecialist,
  EnterprisePositionRoleMapping,
} from '../../preload/index.js';

const FEATURE_LABELS: Array<[keyof EnterpriseOrganizationFeatures, string]> = [
  ['enterprise_tree', '企业组织树'],
  ['park_service', '园区服务'],
  ['feishu_auto_reply', '飞书自动回答'],
  ['direct_messages', '企业内部消息'],
  ['atoa', 'Otto 间协作'],
  ['knowledge', '企业知识库'],
  ['skill_market', '企业 Skill 市场'],
];

const ROLE_LABEL: Record<EnterprisePositionRoleMapping, string> = {
  member: '普通成员',
  department_admin: '部门管理员',
  enterprise_admin: '企业管理员',
};

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');
}

export function EnterpriseAdministrationPanel({
  accounts,
  onChanged,
  onFeaturesLoaded,
}: {
  accounts: EnterpriseAccount[];
  onChanged?: () => void;
  onFeaturesLoaded?: (features: EnterpriseOrganizationFeatures) => void;
}): React.JSX.Element {
  const [features, setFeatures] = useState<EnterpriseOrganizationFeatures | null>(null);
  const [departments, setDepartments] = useState<EnterpriseOrganizationDepartment[]>([]);
  const [park, setPark] = useState<EnterprisePark | null>(null);
  const [parkServices, setParkServices] = useState<EnterpriseParkService[]>([]);
  const [specialists, setSpecialists] = useState<EnterpriseParkSpecialist[]>([]);
  const [parkInvite, setParkInvite] = useState<EnterpriseParkInvite | null>(null);
  const [newDepartment, setNewDepartment] = useState('');
  const [parkInviteCode, setParkInviteCode] = useState('');
  const [parkAddress, setParkAddress] = useState('');
  const [parkRoomNumber, setParkRoomNumber] = useState('');
  const [specialistSelections, setSpecialistSelections] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!window.otto.enterpriseOrganizationFeaturesGet) return;
    try {
      const nextFeatures = await window.otto.enterpriseOrganizationFeaturesGet();
      setFeatures(nextFeatures);
      onFeaturesLoaded?.(nextFeatures);
      const nextDepartments = nextFeatures.enterprise_tree
        ? await window.otto.enterpriseOrganizationDepartments()
        : [];
      setDepartments(nextDepartments);
      if (nextFeatures.park_service) {
        const nextPark = await window.otto.enterpriseParkView();
        setPark(nextPark);
        setParkAddress(nextPark?.tenantAddress ?? '');
        setParkRoomNumber(nextPark?.tenantRoomNumber ?? '');
        if (nextPark?.isAdminOrganization) {
          const [services, people] = await Promise.all([
            window.otto.enterpriseParkServices(),
            window.otto.enterpriseParkSpecialists(),
          ]);
          setParkServices(services);
          setSpecialists(people);
        } else {
          setParkServices(nextPark?.services ?? []);
          setSpecialists([]);
        }
      } else {
        setPark(null);
        setParkServices([]);
        setSpecialists([]);
      }
      setError(null);
    } catch (cause) {
      setError(cleanError(cause));
    }
  }, [onFeaturesLoaded]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (operation: () => Promise<unknown>, success: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await operation();
      await refresh();
      onChanged?.();
      setMessage(success);
      return true;
    } catch (cause) {
      setError(cleanError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const activeAccounts = useMemo(
    () => accounts.filter((account) => account.status === 'active'),
    [accounts],
  );

  return (
    <section className="otto-enterprise-config" aria-label="企业组织与园区配置">
      <header className="otto-enterprise-config__hero">
        <div>
          <span>ENTERPRISE CONTROL</span>
          <h2>企业配置中心</h2>
          <p>组织结构、权限开关和产业园端分区管理。这里的修改直接写入中心企业服务器，并同步到所有成员。</p>
        </div>
        <button type="button" className="otto-enterprise-config__refresh" disabled={busy} onClick={() => void refresh()}>刷新</button>
      </header>

      {error ? <div className="otto-account-invite__error" role="alert">{error}</div> : null}
      {message ? <div className="otto-account-invite__success" role="status">{message}</div> : null}

      {features ? (
        <div className="otto-enterprise-config__card">
          <h3>功能开关</h3><p>开关决定客户端是否展示对应能力；关闭后服务端接口同时 fail closed。</p>
          <div className="otto-enterprise-config__switches">
            {FEATURE_LABELS.map(([key, label]) => (
              <label key={key} className="otto-enterprise-config__switch">
                <input
                  type="checkbox"
                  checked={features[key]}
                  disabled={busy}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void run(
                      () => window.otto.enterpriseOrganizationFeaturesUpdate({ [key]: enabled }),
                      `${label}已${enabled ? '开启' : '关闭'}`,
                    );
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {features?.enterprise_tree ? (
        <div className="otto-enterprise-config__card">
          <h3>组织结构</h3><p>用职位映射权限，避免单独给人手动加权导致权限漂移。</p>
          <div className="otto-enterprise-config__department-create">
            <label>
              <span>新部门</span>
              <input value={newDepartment} onChange={(event) => setNewDepartment(event.target.value)} placeholder="例如：产业合作部" />
            </label>
            <button className="is-primary" type="button" disabled={busy || !newDepartment.trim()} onClick={() => {
              void run(
                () => window.otto.enterpriseOrganizationDepartmentCreate(newDepartment.trim()),
                '部门已创建',
              ).then((saved) => { if (saved) setNewDepartment(''); });
            }}>新增部门</button>
          </div>
          <div className="otto-enterprise-config__department-list">
            {departments.map((department, departmentIndex) => (
              <section
                key={department.id}
                className="otto-enterprise-config__department"
                aria-label={`${department.name}部门设置`}
              >
                <header className="otto-enterprise-config__department-head">
                  <span className="otto-enterprise-config__department-index" aria-hidden="true">
                    {String(departmentIndex + 1).padStart(2, '0')}
                  </span>
                  <div className="otto-enterprise-config__department-title">
                    <label htmlFor={`department-${department.id}`}>部门名称</label>
                    <input
                      id={`department-${department.id}`}
                      defaultValue={department.name}
                    />
                    <p>
                      {department.memberCount} 名在职成员 · {department.positions.length} 个职位
                    </p>
                  </div>
                  <div className="otto-enterprise-config__department-actions">
                    <button type="button" disabled={busy} onClick={() => {
                  const input = document.getElementById(`department-${department.id}`) as HTMLInputElement | null;
                  void run(
                    () => window.otto.enterpriseOrganizationDepartmentUpdate(department.id, input?.value.trim() || ''),
                    '部门名称已更新',
                  );
                    }}>保存名称</button>
                    <button
                      type="button"
                      className="is-danger"
                      title={department.memberCount > 0 || department.positions.length > 0 ? '请先移走成员并删除职位' : '删除这个空部门'}
                      disabled={busy || department.memberCount > 0 || department.positions.length > 0}
                      onClick={() => {
                  void run(
                    () => window.otto.enterpriseOrganizationDepartmentDelete(department.id),
                    '空部门已删除',
                  );
                      }}
                    >删除空部门</button>
                  </div>
                </header>

                <div className="otto-enterprise-config__positions">
                  <div className="otto-enterprise-config__positions-head">
                    <h4>部门职位</h4>
                    <span>职位权限会同步到该职位的所有成员</span>
                  </div>
                  {department.positions.length > 0 ? (
                    <div className="otto-enterprise-config__position-list">
                      {department.positions.map((position, positionIndex) => (
                        <div key={position.id} className="otto-enterprise-config__position">
                          <span className="otto-enterprise-config__position-index" aria-hidden="true">
                            {positionIndex + 1}
                          </span>
                          <label>
                            <span>职位名称</span>
                            <input defaultValue={position.title} id={`position-${position.id}`} aria-label={`${department.name}职位名称`} />
                          </label>
                          <label>
                            <span>权限映射</span>
                            <select defaultValue={position.roleMapping} id={`position-role-${position.id}`} aria-label={`${position.title}权限映射`}>
                              {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                          </label>
                          <div className="otto-enterprise-config__position-actions">
                            <button type="button" disabled={busy} onClick={() => {
                              const title = (document.getElementById(`position-${position.id}`) as HTMLInputElement | null)?.value.trim();
                              const roleMapping = (document.getElementById(`position-role-${position.id}`) as HTMLSelectElement | null)?.value as EnterprisePositionRoleMapping;
                              void run(
                                () => window.otto.enterpriseOrganizationPositionUpdate(position.id, { title, roleMapping }),
                                '职位与权限映射已更新',
                              );
                            }}>保存职位</button>
                            <button className="is-danger" type="button" disabled={busy} title="仅空职位可以删除" onClick={() => {
                              void run(() => window.otto.enterpriseOrganizationPositionDelete(position.id), '空职位已删除');
                            }}>删除</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="otto-enterprise-config__positions-empty">这个部门还没有职位，请在下方创建第一个职位。</p>
                  )}

                  <form
                    className="otto-enterprise-config__position-create"
                    aria-label={`为${department.name}新增职位`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      const data = new FormData(form);
                      const title = String(data.get('title') ?? '').trim();
                      const roleMapping = String(data.get('roleMapping') ?? 'member') as EnterprisePositionRoleMapping;
                      if (!title) return;
                      void run(() => window.otto.enterpriseOrganizationPositionCreate({
                        departmentId: department.id,
                        title,
                        roleMapping,
                      }), '职位已创建').then((saved) => { if (saved) form.reset(); });
                    }}
                  >
                    <label>
                      <span>新增职位</span>
                      <input name="title" required placeholder="例如：产品经理" />
                    </label>
                    <label>
                      <span>权限映射</span>
                      <select name="roleMapping" defaultValue="member">
                        {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                    <button type="submit" disabled={busy}>添加到本部门</button>
                  </form>
                </div>
              </section>
            ))}
            {departments.length === 0 ? (
              <p className="otto-enterprise-config__positions-empty">暂时没有部门，请先创建一个部门。</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {features?.park_service ? (
        <div className="otto-enterprise-config__card">
          <h3>产业园端</h3><p>产业园管理方可以签发邀请码邀请其他企业入驻；普通企业只能凭有效邀请码加入。</p>
          {park ? (
            <>
              <div className="otto-enterprise-config__park-state"><div><strong>{park.brandName}</strong><span>{park.name}</span></div><b>{park.isAdminOrganization ? '产业园管理方' : '入驻企业'}</b></div>
              {park.isAdminOrganization ? (
                <>
                  <button type="button" disabled={busy} onClick={() => {
                    void run(async () => {
                      const invite = await window.otto.enterpriseParkInviteIssue(null);
                      setParkInvite(invite);
                    }, '产业园邀请码已生成');
                  }}>生成入驻企业邀请码</button>
                  {parkInvite ? <p className="otto-enterprise-config__invite">入驻邀请码：<strong>{parkInvite.code}</strong><span>7 天有效，已使用 {parkInvite.usedCount} 次</span></p> : null}
                  {parkServices.map((service) => {
                    const assigned = specialists.filter((item) => item.serviceId === service.id);
                    const assignedIds = new Set(assigned.map((item) => item.accountId));
                    const availableAccounts = activeAccounts.filter((account) => !assignedIds.has(account.id));
                    const selectedAccountId = specialistSelections[service.id] || '';
                    return (
                      <div key={service.id} className="otto-enterprise-config__service">
                        <div className="otto-enterprise-config__service-head">
                          <div><strong>{service.name}</strong><span>{assigned.length ? `${assigned.length} 名服务专员` : '未指定时投递产业园管理员'}</span></div>
                          <label className="otto-enterprise-config__service-toggle">
                            <span>{service.enabled ? '已启用' : '已停用'}</span>
                            <input type="checkbox" checked={service.enabled} disabled={busy} onChange={(event) => {
                              void run(() => window.otto.enterpriseParkServiceUpdate({
                                serviceId: service.id,
                                enabled: event.target.checked,
                              }), `${service.name}已${event.target.checked ? '启用' : '停用'}`);
                            }} />
                          </label>
                        </div>
                        <div className="otto-enterprise-config__specialist-picker">
                          <label>
                            <span>添加服务专员</span>
                            <select
                              aria-label={`${service.name}添加服务专员`}
                              value={selectedAccountId}
                              disabled={busy || !service.enabled || availableAccounts.length === 0}
                              onChange={(event) => setSpecialistSelections((current) => ({
                                ...current,
                                [service.id]: event.target.value,
                              }))}
                            >
                              <option value="">{availableAccounts.length ? '请选择企业成员' : '所有可用成员均已添加'}</option>
                              {availableAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                            </select>
                          </label>
                          <button
                            type="button"
                            disabled={busy || !service.enabled || !selectedAccountId}
                            onClick={() => {
                              void run(
                                () => window.otto.enterpriseParkSpecialistSet(service.id, selectedAccountId),
                                '服务专员已添加',
                              ).then((saved) => {
                                if (saved) setSpecialistSelections((current) => ({ ...current, [service.id]: '' }));
                              });
                            }}
                          >添加</button>
                        </div>
                        {assigned.length ? (
                          <div className="otto-enterprise-config__specialists" aria-label={`${service.name}已分配专员`}>
                            {assigned.map((specialist) => (
                              <span key={specialist.accountId} className="otto-enterprise-config__specialist">
                                <b>{specialist.name}</b>
                                <button
                                  type="button"
                                  aria-label={`从${service.name}移除${specialist.name}`}
                                  disabled={busy}
                                  onClick={() => {
                                    void run(
                                      () => window.otto.enterpriseParkSpecialistRemove(service.id, specialist.accountId),
                                      '服务专员已移除',
                                    );
                                  }}
                                >移除</button>
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </>
              ) : (
                <div className="otto-account-invite__controls">
                  <label>企业地址<input value={parkAddress} onChange={(event) => setParkAddress(event.target.value)} maxLength={160} placeholder="例如：科技大厦 A 座" /></label>
                  <label>门牌/房间号<input value={parkRoomNumber} onChange={(event) => setParkRoomNumber(event.target.value)} maxLength={40} placeholder="例如：1203 室" /></label>
                  <button type="button" disabled={busy || !parkAddress.trim() || !parkRoomNumber.trim()} onClick={() => {
                    void run(() => window.otto.enterpriseParkProfileUpdate({
                      address: parkAddress.trim(),
                      roomNumber: parkRoomNumber.trim(),
                    }), '企业入驻资料已更新');
                  }}>保存入驻资料</button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="otto-account-invite__controls">
                <label>产业园邀请码<input value={parkInviteCode} onChange={(event) => setParkInviteCode(event.target.value)} placeholder="Aa3B-k9Pq-Z7xY" /></label>
                <label>企业地址<input value={parkAddress} onChange={(event) => setParkAddress(event.target.value)} maxLength={160} placeholder="例如：科技大厦 A 座" /></label>
                <label>门牌/房间号<input value={parkRoomNumber} onChange={(event) => setParkRoomNumber(event.target.value)} maxLength={40} placeholder="例如：1203 室" /></label>
                <button type="button" disabled={busy || !parkInviteCode.trim() || !parkAddress.trim() || !parkRoomNumber.trim()} onClick={() => {
                  void run(() => window.otto.enterpriseParkJoin({
                    inviteCode: parkInviteCode.trim(),
                    address: parkAddress.trim(),
                    roomNumber: parkRoomNumber.trim(),
                  }), '整个企业已加入产业园');
                }}>作为入驻企业加入</button>
              </div>
              <p className="otto-enterprise-config__hint">创建产业园端需要平台管理员在多企业管理页面完成认证。普通企业 CEO 填写邀请码、企业地址和门牌号后，整个企业加入已有产业园。</p>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
