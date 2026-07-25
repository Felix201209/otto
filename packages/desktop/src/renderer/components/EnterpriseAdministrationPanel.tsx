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
  const [newPositionDepartment, setNewPositionDepartment] = useState('');
  const [newPositionTitle, setNewPositionTitle] = useState('');
  const [newPositionRole, setNewPositionRole] = useState<EnterprisePositionRoleMapping>('member');
  const [parkInviteCode, setParkInviteCode] = useState('');
  const [newParkName, setNewParkName] = useState('');
  const [newParkBrand, setNewParkBrand] = useState('');
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
      setNewPositionDepartment((current) => current || nextDepartments[0]?.id || '');
      if (nextFeatures.park_service) {
        const nextPark = await window.otto.enterpriseParkView();
        setPark(nextPark);
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
    <section className="otto-account-invite" aria-label="企业组织与园区配置">
      <header>
        <div>
          <span>ENTERPRISE CONFIGURATION</span>
          <h2>组织结构、功能开关与园区</h2>
          <p>这里直接修改中心企业服务器。部门、职位权限、园区归属与专员投递会同步到所有成员。</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void refresh()}>刷新</button>
      </header>

      {error ? <div className="otto-account-invite__error" role="alert">{error}</div> : null}
      {message ? <div className="otto-account-invite__success" role="status">{message}</div> : null}

      {features ? (
        <div className="otto-account-form__section">
          <h3>企业功能开关</h3>
          <div className="otto-account-form__tags">
            {FEATURE_LABELS.map(([key, label]) => (
              <label key={key} className="otto-account-form__check">
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
        <div className="otto-account-form__section">
          <h3>自定义部门与职位权限</h3>
          <div className="otto-account-invite__controls">
            <label>新部门<input value={newDepartment} onChange={(event) => setNewDepartment(event.target.value)} placeholder="例如：产业合作部" /></label>
            <button type="button" disabled={busy || !newDepartment.trim()} onClick={() => {
              void run(
                () => window.otto.enterpriseOrganizationDepartmentCreate(newDepartment.trim()),
                '部门已创建',
              ).then((saved) => { if (saved) setNewDepartment(''); });
            }}>新增部门</button>
          </div>
          {departments.map((department) => (
            <div key={department.id} className="otto-account-invite__result">
              <div className="otto-account-invite__controls">
                <label>部门名称<input defaultValue={department.name} id={`department-${department.id}`} /></label>
                <button type="button" disabled={busy} onClick={() => {
                  const input = document.getElementById(`department-${department.id}`) as HTMLInputElement | null;
                  void run(
                    () => window.otto.enterpriseOrganizationDepartmentUpdate(department.id, input?.value.trim() || ''),
                    '部门名称已更新',
                  );
                }}>保存名称</button>
                <button type="button" disabled={busy || department.memberCount > 0 || department.positions.length > 0} onClick={() => {
                  void run(
                    () => window.otto.enterpriseOrganizationDepartmentDelete(department.id),
                    '空部门已删除',
                  );
                }}>删除空部门</button>
              </div>
              <p>{department.memberCount} 名在职成员</p>
              {department.positions.map((position) => (
                <div key={position.id} className="otto-account-invite__controls">
                  <input defaultValue={position.title} id={`position-${position.id}`} aria-label={`${department.name}职位名称`} />
                  <select defaultValue={position.roleMapping} id={`position-role-${position.id}`} aria-label={`${position.title}权限映射`}>
                    {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <button type="button" disabled={busy} onClick={() => {
                    const title = (document.getElementById(`position-${position.id}`) as HTMLInputElement | null)?.value.trim();
                    const roleMapping = (document.getElementById(`position-role-${position.id}`) as HTMLSelectElement | null)?.value as EnterprisePositionRoleMapping;
                    void run(
                      () => window.otto.enterpriseOrganizationPositionUpdate(position.id, { title, roleMapping }),
                      '职位与权限映射已更新',
                    );
                  }}>保存职位</button>
                  <button type="button" disabled={busy} onClick={() => {
                    void run(() => window.otto.enterpriseOrganizationPositionDelete(position.id), '空职位已删除');
                  }}>删除空职位</button>
                </div>
              ))}
            </div>
          ))}
          <div className="otto-account-invite__controls">
            <label>所属部门<select value={newPositionDepartment} onChange={(event) => setNewPositionDepartment(event.target.value)}><option value="">请选择</option>{departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
            <label>职位名称<input value={newPositionTitle} onChange={(event) => setNewPositionTitle(event.target.value)} placeholder="例如：产品经理" /></label>
            <label>权限映射<select value={newPositionRole} onChange={(event) => setNewPositionRole(event.target.value as EnterprisePositionRoleMapping)}>{Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <button type="button" disabled={busy || !newPositionDepartment || !newPositionTitle.trim()} onClick={() => {
              void run(() => window.otto.enterpriseOrganizationPositionCreate({
                departmentId: newPositionDepartment,
                title: newPositionTitle.trim(),
                roleMapping: newPositionRole,
              }), '职位已创建').then((saved) => { if (saved) setNewPositionTitle(''); });
            }}>新增职位</button>
          </div>
        </div>
      ) : null}

      {features?.park_service ? (
        <div className="otto-account-form__section">
          <h3>产业园归属与服务</h3>
          {park ? (
            <>
              <p><strong>{park.brandName}</strong> · {park.name} · {park.isAdminOrganization ? '产业园管理方' : '入驻企业'}</p>
              {park.isAdminOrganization ? (
                <>
                  <button type="button" disabled={busy} onClick={() => {
                    void run(async () => {
                      const invite = await window.otto.enterpriseParkInviteIssue(null);
                      setParkInvite(invite);
                    }, '产业园邀请码已生成');
                  }}>生成产业园邀请码</button>
                  {parkInvite ? <p>邀请码：<strong>{parkInvite.code}</strong>（7 天有效，已使用 {parkInvite.usedCount} 次）</p> : null}
                  {parkServices.map((service) => {
                    const assigned = specialists.find((item) => item.serviceId === service.id);
                    return (
                      <div key={service.id} className="otto-account-invite__controls">
                        <label>{service.name}<input type="checkbox" checked={service.enabled} disabled={busy} onChange={(event) => {
                          void run(() => window.otto.enterpriseParkServiceUpdate({
                            serviceId: service.id,
                            enabled: event.target.checked,
                          }), `${service.name}已${event.target.checked ? '启用' : '停用'}`);
                        }} /></label>
                        <label>服务专员<select value={assigned?.accountId || ''} disabled={busy || !service.enabled} onChange={(event) => {
                          const accountId = event.target.value;
                          void run(async () => {
                            if (assigned) await window.otto.enterpriseParkSpecialistRemove(service.id, assigned.accountId);
                            if (accountId) await window.otto.enterpriseParkSpecialistSet(service.id, accountId);
                          }, accountId ? '服务专员已设置' : '服务专员已清除');
                        }}><option value="">未设置（投递园区管理员）</option>{activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
                      </div>
                    );
                  })}
                </>
              ) : null}
            </>
          ) : (
            <>
              <div className="otto-account-invite__controls">
                <label>产业园邀请码<input value={parkInviteCode} onChange={(event) => setParkInviteCode(event.target.value)} placeholder="XXXX-XXXX" /></label>
                <button type="button" disabled={busy || !parkInviteCode.trim()} onClick={() => {
                  void run(() => window.otto.enterpriseParkJoin(parkInviteCode.trim()), '整个企业已加入产业园');
                }}>加入产业园</button>
              </div>
              <div className="otto-account-invite__controls">
                <label>注册产业园<input value={newParkName} onChange={(event) => setNewParkName(event.target.value)} placeholder="例如：科技大厦" /></label>
                <label>服务品牌<input value={newParkBrand} onChange={(event) => setNewParkBrand(event.target.value)} placeholder="例如：科技大厦园区服务" /></label>
                <button type="button" disabled={busy || !newParkName.trim()} onClick={() => {
                  void run(() => window.otto.enterpriseParkRegister({
                    name: newParkName.trim(),
                    brandName: newParkBrand.trim() || `${newParkName.trim()}服务`,
                  }), '产业园已注册');
                }}>注册为产业园管理方</button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
