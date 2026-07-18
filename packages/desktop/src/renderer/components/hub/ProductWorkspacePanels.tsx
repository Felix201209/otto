/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import type { ModelInfo } from 'otto-server';
import {
  ALL_POSITION_CAPABILITIES,
  POSITION_CAPABILITY_LABELS,
  type PositionCapability,
} from 'otto-server/dist/src/productWorkspace.js';
import type { UseProductWorkspace } from '../../state/useProductWorkspace.js';
import { Card, Empty, Panel } from './HubUI.js';

/** 弹窗：CEO 管理某职位的授权能力 */
function GrantCapabilitiesDialog({
  positionTitle,
  current,
  onSave,
  onClose,
}: {
  positionTitle: string;
  current: PositionCapability[];
  onSave(caps: PositionCapability[]): void;
  onClose(): void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<Set<PositionCapability>>(new Set(current));

  function toggle(cap: PositionCapability) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cap)) next.delete(cap);
      else next.add(cap);
      return next;
    });
  }

  return (
    <div className="otto-dialog-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="otto-dialog">
        <div className="otto-dialog__header">
          <strong>管理职位权限</strong>
          <span>{positionTitle}</span>
          <button type="button" className="otto-dialog__close" onClick={onClose}>✕</button>
        </div>
        <p className="otto-hub__field-hint">
          勾选后该职位持有者将在自己的 Otto 面板中看到对应操作入口。
        </p>
        <div className="otto-dialog__caps">
          {ALL_POSITION_CAPABILITIES.map((cap) => (
            <label key={cap} className="otto-dialog__cap-row">
              <input
                type="checkbox"
                checked={selected.has(cap)}
                onChange={() => toggle(cap)}
              />
              <span>{POSITION_CAPABILITY_LABELS[cap]}</span>
            </label>
          ))}
        </div>
        <div className="otto-dialog__footer">
          <button type="button" className="otto-hub__btn" onClick={onClose}>取消</button>
          <button
            type="button"
            className="otto-hub__btn otto-hub__btn--primary"
            onClick={() => { onSave([...selected]); onClose(); }}
          >
            保存权限
          </button>
        </div>
      </div>
    </div>
  );
}

export function OrganizationPanel({
  product,
}: {
  product: UseProductWorkspace;
}): React.JSX.Element {
  const { state, actions } = product;
  const workspace = state.workspace;
  const [flow, setFlow] = useState<'none' | 'owner' | 'join'>('none');
  const [managerName, setManagerName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [industry, setIndustry] = useState('');
  const [employeeScale, setEmployeeScale] = useState('1-50人');
  const [joinLink, setJoinLink] = useState('');
  const [joinName, setJoinName] = useState('');
  const [selectedPosition, setSelectedPosition] = useState('');
  const [targetCompanyId, setTargetCompanyId] = useState('');
  const [companyLink, setCompanyLink] = useState('');
  // 管理权限弹窗
  const [grantDialogPos, setGrantDialogPos] = useState<string | null>(null);

  const organization = workspace?.managerWorkspace?.organization;
  const positions = organization?.positions ?? [];
  const departments = organization?.departments ?? [];

  const departmentById = useMemo(
    () => new Map(departments.map((d) => [d.id, d.name])),
    [departments],
  );
  const positionById = useMemo(
    () => new Map(positions.map((p) => [p.id, p])),
    [positions],
  );

  if (!workspace) {
    return <Panel title="企业与身份" desc="正在读取服务端身份…"><Empty>加载中…</Empty></Panel>;
  }

  const isEnterprise = workspace.context.edition === 'enterprise';
  const isOwner = workspace.context.role === 'company_owner' || workspace.context.role === 'company_admin';
  const members = workspace.members ?? [];
  const myCaps = workspace.context.capabilities ?? [];

  // HR 功能入口：持有能力时才展示
  const canIssueInvite = myCaps.includes('invite:issue') && !isOwner;
  const canViewAll = myCaps.includes('org:view_all') && !isOwner;
  const canRemoveMember = myCaps.includes('member:remove') && !isOwner;
  const canTransfer = myCaps.includes('member:transfer') && !isOwner;
  const canAssignPosition = myCaps.includes('position:assign') && !isOwner;
  const hasAnyGrantedCap = canIssueInvite || canViewAll || canRemoveMember || canTransfer || canAssignPosition;

  // 当前正在编辑权限的职位
  const grantDialogPosition = grantDialogPos ? positionById.get(grantDialogPos) : null;

  return (
    <Panel
      title="企业与身份"
      desc="个人 API 与企业身份严格隔离；企业版身份由服务端签名链接和角色权限决定。"
      actions={
        isEnterprise ? (
          <button type="button" className="otto-hub__btn" onClick={actions.switchToPersonal}>
            切回个人版
          </button>
        ) : undefined
      }
    >
      {/* 管理权限弹窗 */}
      {grantDialogPosition ? (
        <GrantCapabilitiesDialog
          positionTitle={grantDialogPosition.title}
          current={(grantDialogPosition.grantedCapabilities ?? []) as PositionCapability[]}
          onSave={(caps) => actions.grantPositionCapabilities(grantDialogPosition.id, caps)}
          onClose={() => setGrantDialogPos(null)}
        />
      ) : null}

      {!isEnterprise ? (
        <>
          <div className="otto-product-choice">
            <button type="button" className={flow === 'owner' ? 'is-active' : ''} onClick={() => setFlow('owner')}>
              <strong>我是企业管理者</strong>
              <span>填写企业信息，由 Otto 构建初始部门和负责人岗位</span>
            </button>
            <button type="button" className={flow === 'join' ? 'is-active' : ''} onClick={() => setFlow('join')}>
              <strong>我要加入一个公司</strong>
              <span>粘贴 CEO 发给你的职位邀请链接</span>
            </button>
          </div>

          {flow === 'owner' ? (
            <Card>
              <div className="otto-product-form">
                <label>管理者姓名<input value={managerName} onChange={(e) => setManagerName(e.target.value)} placeholder="例如：陈晨" /></label>
                <label>企业名称<input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="例如：北辰科技" /></label>
                <label>所属行业<input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="例如：企业软件" /></label>
                <label>企业规模
                  <select value={employeeScale} onChange={(e) => setEmployeeScale(e.target.value)}>
                    <option>1-50人</option>
                    <option>51-200人</option>
                    <option>201-500人</option>
                    <option>500人以上</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="otto-hub__btn otto-hub__btn--primary"
                  disabled={!managerName.trim() || !companyName.trim()}
                  onClick={() => actions.configureEnterprise({
                    managerName: managerName.trim(),
                    companyName: companyName.trim(),
                    industry: industry.trim(),
                    employeeScale,
                  })}
                >
                  构建我的企业框架
                </button>
              </div>
            </Card>
          ) : null}

          {flow === 'join' ? (
            <Card>
              <div className="otto-product-form">
                <label>你的姓名<input value={joinName} onChange={(e) => setJoinName(e.target.value)} placeholder="例如：李明" /></label>
                <label>
                  职位邀请链接
                  <textarea
                    value={joinLink}
                    onChange={(e) => setJoinLink(e.target.value)}
                    placeholder="粘贴 CEO 发给你的链接（otto://enterprise/join?token=…）"
                    rows={3}
                  />
                </label>
                <button
                  type="button"
                  className="otto-hub__btn otto-hub__btn--primary"
                  disabled={!joinName.trim() || !joinLink.trim()}
                  onClick={() => actions.joinEnterprise(
                    joinLink.trim(),
                    workspace.context.userId,
                    joinName.trim(),
                  )}
                >
                  验证链接并加入
                </button>
              </div>
            </Card>
          ) : null}
        </>
      ) : (
        <>
          {/* 当前身份卡片 */}
          <Card>
            <div className="otto-product-identity">
              <div><span>当前身份</span><strong>{isOwner ? 'CEO · 企业管理者' : '企业成员'}</strong></div>
              <div><span>企业</span><strong>{workspace.managerWorkspace?.profile.companyName ?? workspace.context.companyId}</strong></div>
              {!isOwner && workspace.context.departmentId ? (
                <div>
                  <span>部门</span>
                  <strong>{departmentById.get(workspace.context.departmentId) ?? workspace.context.departmentId}</strong>
                </div>
              ) : null}
              {!isOwner && workspace.context.positionId ? (
                <div>
                  <span>职位</span>
                  <strong>{positionById.get(workspace.context.positionId)?.title ?? workspace.context.positionId}</strong>
                </div>
              ) : null}
              <div><span>模型策略</span><strong>内部测试 · 成员个人 API</strong></div>
            </div>
          </Card>

          {/* HR 授权功能入口（员工持有对应能力时才展示） */}
          {hasAnyGrantedCap ? (
            <Card>
              <div className="otto-hub__field-label">HR 管理工具</div>
              <p className="otto-hub__field-hint">以下功能由 CEO 授权给你的职位，代表公司执行。</p>
              <div className="otto-product-hr-tools">
                {canIssueInvite ? (
                  <div className="otto-product-hr-tool">
                    <strong>签发邀请链接（加人）</strong>
                    <span>为指定职位生成邀请链接，发给新员工</span>
                    <div className="otto-product-form" style={{ marginTop: 8 }}>
                      <label>
                        职位
                        <select value={selectedPosition} onChange={(e) => setSelectedPosition(e.target.value)}>
                          <option value="">— 选择职位 —</option>
                          {positions.map((pos) => (
                            <option key={pos.id} value={pos.id}>
                              {departmentById.get(pos.departmentId)} · {pos.title}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="otto-hub__btn otto-hub__btn--primary"
                        disabled={!selectedPosition}
                        onClick={() => {
                          const pos = positions.find((p) => p.id === selectedPosition);
                          if (pos) actions.createInvite({
                            kind: 'position',
                            positionId: pos.id,
                            departmentId: pos.departmentId,
                          });
                        }}
                      >
                        生成邀请链接
                      </button>
                    </div>
                    {state.lastInvite ? (
                      <div className="otto-product-invite-result" style={{ marginTop: 8 }}>
                        <strong>链接已生成 · {new Date(state.lastInvite.expiresAt).toLocaleString('zh-CN')} 失效</strong>
                        <textarea readOnly value={state.lastInvite.link} rows={3} />
                        <button type="button" className="otto-hub__btn" onClick={() => { window.otto.writeClipboard(state.lastInvite!.link); }}>复制链接</button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {canViewAll ? (
                  <div className="otto-product-hr-tool">
                    <strong>全员名单</strong>
                    <span>查看所有成员的部门、职位和状态</span>
                    <div className="otto-product-members" style={{ marginTop: 8 }}>
                      {members.map((m) => {
                        const pos = m.positionId ? positionById.get(m.positionId) : null;
                        const dn = m.departmentId ? departmentById.get(m.departmentId) : null;
                        return (
                          <div key={m.userId} className="otto-product-member-row">
                            <div className="otto-product-member-info">
                              <strong>{m.displayName}</strong>
                              <span>{dn ?? '未分配部门'}{pos ? ` · ${pos.title}` : ''}</span>
                            </div>
                            {canAssignPosition && !m.positionId ? (
                              <button type="button" className="otto-hub__btn otto-hub__btn--sm" onClick={() => setSelectedPosition('')}>指定职位</button>
                            ) : null}
                            {canTransfer && m.positionId ? (
                              <button type="button" className="otto-hub__btn otto-hub__btn--sm" onClick={() => setSelectedPosition(m.positionId!)}>调岗</button>
                            ) : null}
                            {canRemoveMember && m.role !== 'company_owner' ? (
                              <button type="button" className="otto-hub__btn otto-hub__btn--sm otto-hub__btn--danger" title="移除成员">离职</button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : null}

          {/* CEO：部门框架概览 */}
          {isOwner && organization ? (
            <Card>
              <div className="otto-hub__field-label">部门框架</div>
              <div className="otto-product-framework">
                {departments.map((dept) => {
                  const lead = positions.find((p) => p.departmentId === dept.id);
                  const leadMember = lead?.incumbentUserId
                    ? members.find((m) => m.userId === lead.incumbentUserId)
                    : null;
                  return (
                    <div key={dept.id}>
                      <strong>{dept.name}</strong>
                      <span>
                        {lead?.title ?? '待设置负责人'}
                        {leadMember ? ` · ${leadMember.displayName}` : ''}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : null}

          {/* CEO：成员总览 */}
          {isOwner ? (
            <Card>
              <div className="otto-hub__field-label">成员总览（{members.length} 人）</div>
              {members.length === 0 ? (
                <p className="otto-hub__field-hint">暂无成员，生成职位邀请链接发给员工后他们会出现在这里。</p>
              ) : (
                <div className="otto-product-members">
                  {members.map((member) => {
                    const pos = member.positionId ? positionById.get(member.positionId) : null;
                    const deptName = member.departmentId ? departmentById.get(member.departmentId) : null;
                    return (
                      <div key={member.userId} className="otto-product-member-row">
                        <div className="otto-product-member-info">
                          <strong>{member.displayName}</strong>
                          <span>
                            {deptName ?? '未分配部门'}
                            {pos ? ` · ${pos.title}` : ''}
                            {member.role === 'company_owner' ? ' · CEO' : ''}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {member.role !== 'company_owner' ? (
                            <button
                              type="button"
                              className="otto-hub__btn otto-hub__btn--sm"
                              onClick={() => setSelectedPosition(member.positionId ?? '')}
                            >
                              调整职位
                            </button>
                          ) : null}
                          {/* 管理权限：只对有职位的非CEO成员开放 */}
                          {member.positionId && member.role !== 'company_owner' ? (
                            <button
                              type="button"
                              className="otto-hub__btn otto-hub__btn--sm"
                              onClick={() => setGrantDialogPos(member.positionId!)}
                              title="设置该成员职位可执行的管理操作"
                            >
                              管理权限
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          ) : null}

          {/* CEO：生成职位邀请链接 */}
          {isOwner ? (
            <Card>
              <div className="otto-hub__field-label">生成职位邀请链接</div>
              <p className="otto-hub__field-hint">
                选择一个职位，生成专属邀请链接发给对应员工。员工点击链接后加入，职位信息自动绑定。
                每次生成的链接独立有效（默认 7 天），可重复发给不同人用于同一职位的交接或赋能。
              </p>
              <div className="otto-product-form">
                <label>
                  职位
                  <select value={selectedPosition} onChange={(e) => setSelectedPosition(e.target.value)}>
                    <option value="">— 选择职位 —</option>
                    {positions.map((pos) => (
                      <option key={pos.id} value={pos.id}>
                        {departmentById.get(pos.departmentId)} · {pos.title}
                        {pos.incumbentUserId
                          ? ` （在岗：${members.find((m) => m.userId === pos.incumbentUserId)?.displayName ?? pos.incumbentUserId}）`
                          : ' （空缺）'}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="otto-hub__btn otto-hub__btn--primary"
                  disabled={!selectedPosition}
                  onClick={() => {
                    const pos = positions.find((p) => p.id === selectedPosition);
                    if (pos) actions.createInvite({
                      kind: 'position',
                      positionId: pos.id,
                      departmentId: pos.departmentId,
                    });
                  }}
                >
                  生成邀请链接
                </button>
              </div>

              {state.lastInvite ? (
                <div className="otto-product-invite-result">
                  <strong>链接已生成 · {new Date(state.lastInvite.expiresAt).toLocaleString('zh-CN')} 失效</strong>
                  <textarea readOnly value={state.lastInvite.link} aria-label="生成的职位邀请链接" rows={3} />
                  <button
                    type="button"
                    className="otto-hub__btn"
                    onClick={() => { window.otto.writeClipboard(state.lastInvite!.link); }}
                  >
                    复制链接
                  </button>
                  <span>将此链接直接发给员工，对方在 Otto 中粘贴即可加入对应职位。</span>
                </div>
              ) : null}
            </Card>
          ) : null}

          {/* CEO：总分公司关系 */}
          {isOwner ? (
            <Card>
              <div className="otto-hub__field-label">总分公司关系（高级）</div>
              <p className="otto-hub__field-hint">
                用于多法人主体的企业关联。普通员工邀请无需使用此功能。
              </p>
              <div className="otto-product-form">
                <label>
                  目标企业 ID（可选）
                  <input value={targetCompanyId} onChange={(e) => setTargetCompanyId(e.target.value)} placeholder="company_…" />
                </label>
                <div className="otto-product-link-actions">
                  <button type="button" className="otto-hub__btn" onClick={() => actions.createInvite({
                    kind: 'company_link',
                    direction: 'parent_invites_child',
                    ...(targetCompanyId.trim() ? { targetCompanyId: targetCompanyId.trim() } : {}),
                  })}>引入子公司关系</button>
                  <button type="button" className="otto-hub__btn" onClick={() => actions.createInvite({
                    kind: 'company_link',
                    direction: 'child_requests_parent',
                    ...(targetCompanyId.trim() ? { targetCompanyId: targetCompanyId.trim() } : {}),
                  })}>接入总公司关系</button>
                </div>
                <div className="otto-product-company-accept">
                  <div className="otto-hub__field-label" style={{ marginTop: '12px' }}>输入总公司 / 子公司签名链接</div>
                  <textarea
                    value={companyLink}
                    onChange={(e) => setCompanyLink(e.target.value)}
                    placeholder="otto://enterprise/join?token=…"
                    rows={2}
                  />
                  <button
                    type="button"
                    className="otto-hub__btn otto-hub__btn--primary"
                    disabled={!companyLink.trim()}
                    onClick={() => { actions.acceptCompanyLink(companyLink); setCompanyLink(''); }}
                  >验证并接入企业框架</button>
                </div>
              </div>
            </Card>
          ) : null}
        </>
      )}

      {state.error ? <div className="otto-hub__errbar">{state.error}</div> : null}
    </Panel>
  );
}

export function EnterpriseModelsPanel({
  product,
  models: _models,
}: {
  product: UseProductWorkspace;
  models: ModelInfo[];
}): React.JSX.Element {
  const workspace = product.state.workspace;
  const enterprise = workspace?.context.edition === 'enterprise';

  return (
    <Panel title="企业模型（未启用）" desc="当前为内部测试阶段，企业中转站、积分和充值均不参与真实运行。">
      {!enterprise ? (
        <Empty>个人版使用你绑定的个人 API；请从对话右上角进入模型管理。</Empty>
      ) : (
        <Empty>
          内部成员统一使用自己绑定的 API。企业中转站、托管模型、积分与充值暂不启用，也不会影响聊天请求。
        </Empty>
      )}
    </Panel>
  );
}
