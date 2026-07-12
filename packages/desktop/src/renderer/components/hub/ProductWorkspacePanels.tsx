/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import type { ModelInfo } from 'otto-server';
import type { UseProductWorkspace } from '../../state/useProductWorkspace.js';
import { Card, Empty, Panel } from './HubUI.js';

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

  const organization = workspace?.managerWorkspace?.organization;
  const positions = organization?.positions ?? [];
  const departmentById = useMemo(
    () => new Map(organization?.departments.map((item) => [item.id, item.name]) ?? []),
    [organization?.departments],
  );

  if (!workspace) {
    return <Panel title="企业与身份" desc="正在读取服务端身份…"><Empty>加载中…</Empty></Panel>;
  }

  const isEnterprise = workspace.context.edition === 'enterprise';
  const isOwner = workspace.context.role === 'company_owner' || workspace.context.role === 'company_admin';

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
      {!isEnterprise ? (
        <>
          <div className="otto-product-choice">
            <button type="button" className={flow === 'owner' ? 'is-active' : ''} onClick={() => setFlow('owner')}>
              <strong>我是企业管理者</strong>
              <span>填写企业信息，由 Otto 构建初始部门和负责人岗位</span>
            </button>
            <button type="button" className={flow === 'join' ? 'is-active' : ''} onClick={() => setFlow('join')}>
              <strong>我要加入一个公司</strong>
              <span>粘贴企业签发的复杂链接，进入对应部门和职位</span>
            </button>
          </div>

          {flow === 'owner' ? (
            <Card>
              <div className="otto-product-form">
                <label>管理者姓名<input value={managerName} onChange={(event) => setManagerName(event.target.value)} placeholder="例如：陈晨" /></label>
                <label>企业名称<input value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder="例如：北辰科技" /></label>
                <label>所属行业<input value={industry} onChange={(event) => setIndustry(event.target.value)} placeholder="例如：企业软件" /></label>
                <label>企业规模<select value={employeeScale} onChange={(event) => setEmployeeScale(event.target.value)}><option>1-50人</option><option>51-200人</option><option>201-500人</option><option>500人以上</option></select></label>
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
                <label>你的姓名<input value={joinName} onChange={(event) => setJoinName(event.target.value)} /></label>
                <label>企业链接<textarea value={joinLink} onChange={(event) => setJoinLink(event.target.value)} placeholder="otto://enterprise/join?token=…" /></label>
                <button
                  type="button"
                  className="otto-hub__btn otto-hub__btn--primary"
                  disabled={!joinName.trim() || !joinLink.trim()}
                  onClick={() => actions.joinEnterprise(
                    joinLink,
                    workspace.context.userId,
                    joinName,
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
          <Card>
            <div className="otto-product-identity">
              <div><span>当前身份</span><strong>{isOwner ? 'CEO · 企业管理者' : '企业成员'}</strong></div>
              <div><span>企业</span><strong>{workspace.managerWorkspace?.profile.companyName ?? workspace.context.companyId}</strong></div>
              <div><span>模型策略</span><strong>仅 Otto 托管模型</strong></div>
            </div>
          </Card>

          {organization ? (
            <Card>
              <div className="otto-product-framework">
                {organization.departments.map((department) => (
                  <div key={department.id}>
                    <strong>{department.name}</strong>
                    <span>{organization.positions.find((item) => item.departmentId === department.id)?.title ?? '待设置负责人'}</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {isOwner ? (
            <Card>
              <div className="otto-product-form">
                <div className="otto-hub__field-label">生成企业链接</div>
                <label>
                  职位
                  <select value={selectedPosition} onChange={(event) => setSelectedPosition(event.target.value)}>
                    <option value="">选择职位</option>
                    {positions.map((position) => (
                      <option key={position.id} value={position.id}>
                        {departmentById.get(position.departmentId)} · {position.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  目标企业 ID（可选，填写后链接只能由该企业接收）
                  <input value={targetCompanyId} onChange={(event) => setTargetCompanyId(event.target.value)} placeholder="company_…" />
                </label>
                <div className="otto-product-link-actions">
                  <button
                    type="button"
                    className="otto-hub__btn otto-hub__btn--primary"
                    disabled={!selectedPosition}
                    onClick={() => {
                      const position = positions.find((item) => item.id === selectedPosition);
                      if (position) actions.createInvite({
                        kind: 'position',
                        positionId: position.id,
                        departmentId: position.departmentId,
                      });
                    }}
                  >生成职位链接</button>
                  <button type="button" className="otto-hub__btn" onClick={() => actions.createInvite({ kind: 'company' })}>生成公司加入链接</button>
                  <button type="button" className="otto-hub__btn" onClick={() => actions.createInvite({
                    kind: 'company_link',
                    direction: 'parent_invites_child',
                    ...(targetCompanyId.trim() ? { targetCompanyId: targetCompanyId.trim() } : {}),
                  })}>引入子公司链接</button>
                  <button type="button" className="otto-hub__btn" onClick={() => actions.createInvite({
                    kind: 'company_link',
                    direction: 'child_requests_parent',
                    ...(targetCompanyId.trim() ? { targetCompanyId: targetCompanyId.trim() } : {}),
                  })}>接入总公司链接</button>
                </div>
                <div className="otto-product-company-accept">
                  <div className="otto-hub__field-label">输入总公司 / 子公司签名链接</div>
                  <textarea
                    value={companyLink}
                    onChange={(event) => setCompanyLink(event.target.value)}
                    placeholder="otto://enterprise/join?token=…"
                    aria-label="待接入的总分公司链接"
                  />
                  <button
                    type="button"
                    className="otto-hub__btn otto-hub__btn--primary"
                    disabled={!companyLink.trim()}
                    onClick={() => {
                      actions.acceptCompanyLink(companyLink);
                      setCompanyLink('');
                    }}
                  >验证并接入企业框架</button>
                </div>
              </div>
            </Card>
          ) : null}

          {state.lastInvite ? (
            <Card>
              <div className="otto-product-invite-result">
                <strong>链接已签名 · {new Date(state.lastInvite.expiresAt).toLocaleString('zh-CN')} 失效</strong>
                <textarea readOnly value={state.lastInvite.link} aria-label="生成的企业链接" />
                <button type="button" className="otto-hub__btn" onClick={() => void navigator.clipboard.writeText(state.lastInvite!.link)}>复制链接</button>
                <span>当前版本支持粘贴核验；跨设备组织详情需要后续接入企业服务端。</span>
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
  models,
}: {
  product: UseProductWorkspace;
  models: ModelInfo[];
}): React.JSX.Element {
  const workspace = product.state.workspace;
  const enterprise = workspace?.context.edition === 'enterprise';

  return (
    <Panel title="模型与积分" desc="企业版模型由 Otto 托管；显示倍率只用于横向比较，实际扣费按输入/输出 Credits 结算。">
      {!enterprise ? (
        <Empty>个人版使用你绑定的个人 API；请从对话右上角进入模型管理。</Empty>
      ) : (
        <>
          <div className="otto-credit-summary">
            <div><span>可用积分</span><strong>{workspace.credits.balance.toLocaleString('zh-CN')} Credits</strong></div>
            <div><span>首期换算设计</span><strong>¥100 = 10,000 Credits</strong></div>
            <div><span>成本基准</span><strong>≈ ¥90 DeepSeek token</strong></div>
          </div>
          <div className="otto-credit-warning">当前为计费设计预览，尚未接支付和真实余额账本，界面不会伪造充值成功。</div>
          <div className="otto-enterprise-models">
            {models.map((model) => (
              <div key={model.id} className="otto-enterprise-model">
                <div>
                  <strong>{model.displayName}</strong>
                  <span>
                    {model.enabled === false
                      ? '企业模型服务未配置 · 暂不可用'
                      : `${model.tier === 'premium' ? '高端模型' : '标准模型'} · Otto 托管`}
                  </span>
                </div>
                <b>{model.creditMultiplier ?? 1}×</b>
                <small>输入 {model.inputCreditsPerMTok ?? '待定'} / 输出 {model.outputCreditsPerMTok ?? '待定'} Credits / MTok</small>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}
