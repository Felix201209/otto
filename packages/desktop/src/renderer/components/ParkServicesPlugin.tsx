/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 产业园服务入口。
 *
 * 九项园区服务均使用企业服务器：公告和问卷由管理员发布；七类申请按职责标签
 * 自动投递，并用结构化处理表完成受理、回复、办理和验收。
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { insertComposerDraft } from './Composer.js';
import type {
  EnterpriseAccount,
  EnterpriseParkPublication,
  EnterpriseParkResources,
  EnterpriseRepairTicket,
} from '../../preload/index.js';
import defaultMeetingRoomImage from '../assets/meeting-room-default.png';
import {
  IconBuilding,
  IconCalendarCheck,
  IconClose,
  IconIdBadge,
  IconPackage,
  IconUtensils,
  IconWrench,
} from './icons.js';

type IconComponent = (props: { size?: number; className?: string }) => React.JSX.Element;

interface WorkflowStep {
  role: string;
  owner: string;
  detail: string;
}

interface ParkService {
  id: string;
  icon: IconComponent;
  name: string;
  desc: string;
  prompt: string;
  demoSubject?: string;
  steps?: WorkflowStep[];
}

const DEFAULT_BRAND = '宏创园区服务';
const DEFAULT_PARK = '宏创园区';

const ICON_POOL: IconComponent[] = [
  IconBuilding,
  IconIdBadge,
  IconCalendarCheck,
  IconWrench,
  IconPackage,
  IconUtensils,
];

interface ServiceInteraction {
  intro: string;
  quickReplies: string[];
  hint: string;
}

interface ParkActorDirectory {
  currentUser?: string;
  admin?: string;
  serviceDesk?: string;
  repairer?: string;
  operator?: string;
  parking?: string;
  meeting?: string;
  energy?: string;
  security?: string;
}

function ownerForParkStep(
  serviceId: string,
  stepIndex: number,
  actors: ParkActorDirectory,
  fallback: string,
): string {
  if (stepIndex === 0) return actors.currentUser ?? fallback;
  if (stepIndex === 1) return actors.serviceDesk ?? actors.admin ?? fallback;
  if (serviceId === 'parking' && (stepIndex === 2 || stepIndex === 4)) return actors.parking ?? fallback;
  if (serviceId === 'network-phone' && stepIndex >= 3) return actors.repairer ?? fallback;
  if (serviceId === 'meeting-room' && (stepIndex === 2 || stepIndex === 4)) return actors.meeting ?? fallback;
  if (serviceId === 'electric-card' && (stepIndex === 2 || stepIndex === 4)) return actors.energy ?? fallback;
  if (serviceId === 'repair' && (stepIndex === 2 || stepIndex === 3)) return actors.repairer ?? fallback;
  if (serviceId === 'vehicle-visit' && stepIndex >= 2) return actors.security ?? fallback;
  if (stepIndex === 2) return actors.operator ?? actors.admin ?? fallback;
  return fallback;
}

function personalizeParkServices(
  services: ParkService[],
  actors: ParkActorDirectory,
): ParkService[] {
  return services.map((service) => ({
    ...service,
    steps: service.steps?.map((step, index) => ({
      ...step,
      owner: ownerForParkStep(service.id, index, actors, step.owner),
    })),
  }));
}

/** 每项服务的现场沟通方式不同，避免所有业务都变成同一套“下一步”。 */
const SERVICE_INTERACTIONS: Record<string, ServiceInteraction> = {
  renovation: {
    intro: '填写装修申请单并提交即可，申请会直接送达园区客服部，客服人员收到后与企业联系。',
    quickReplies: ['申请单已收到', '需要补充申请资料', '客服将电话联系'],
    hint: '客户只需如实填写并提交申请单，无需在线完成后续装修流程。',
  },
  parking: { intro: '停车办理先核验车牌和车位，再确认门禁开通时间。', quickReplies: ['车牌信息确认', '请帮我查可用车位', '我晚点补充车辆资料'], hint: '车场管理员可以先查位，企业无需反复电话确认。' },
  'network-phone': { intro: '网络/电话申请先确认安装位置和开通日期；工程师也可以先远程指导自查。', quickReplies: ['需求确认，请安排开通', '请远程指导自查线路', '安排工程师上门'], hint: '能远程排除的问题先在线处理，减少工程师无效上门。' },
  'meeting-room': { intro: '会议室预约会先核对人数、时段和设备；如果冲突，客服会给出替代时段。', quickReplies: ['时间人数确认', '帮我换一个会议室', '需要投屏/视频会议'], hint: '预约不是单向提交，冲突时要能直接换房或补充设备。' },
  'electric-card': { intro: '电卡办理先核验卡号和金额，再提示到客服中心的办理时间。', quickReplies: ['充值信息确认', '请核验电卡余额', '我稍后到客服中心'], hint: '金额和卡号需要二次确认，避免错充。' },
  repair: { intro: '请准确填写故障位置和现象，园区会安排维修人员处理。', quickReplies: ['远程指导', '暂时没空', '安排上门', '需要补充信息'], hint: '提交后可在“我的办理进度”中查看接单、回复和完成状态。' },
  'vehicle-visit': { intro: '来访车辆先登记人、车牌和时间；安保端会收到放行信息，改期也可直接留言。', quickReplies: ['登记信息确认', '访客改期', '请告知门岗放行规则'], hint: '访客信息有变化时直接回复即可，不必重新打电话。' },
};

interface ServiceFormField {
  key: string;
  label: string;
  placeholder: string;
  options?: string[];
}

const SERVICE_FORM_FIELDS: Record<string, ServiceFormField[]> = {
  renovation: [
    { key: 'area', label: '装修区域', placeholder: '例如：A 座 1203 室' },
    { key: 'startDate', label: '计划开工日期', placeholder: '例如：2026-08-01' },
    { key: 'content', label: '施工内容', placeholder: '请简要说明施工范围' },
    { key: 'contact', label: '现场联系人', placeholder: '请输入联系人姓名' },
    { key: 'phone', label: '联系电话', placeholder: '请输入手机号码' },
  ],
  parking: [
    { key: 'plate', label: '车牌号', placeholder: '例如：粤 B·A1234' },
    { key: 'vehicleType', label: '车辆类型', placeholder: '请选择车辆类型', options: ['小型客车', '新能源车', '货车', '其他'] },
    { key: 'quantity', label: '申请数量', placeholder: '例如：1' },
    { key: 'contact', label: '联系人', placeholder: '请输入联系人姓名' },
    { key: 'phone', label: '联系电话', placeholder: '请输入手机号码' },
  ],
  'network-phone': [
    { key: 'businessType', label: '业务类型', placeholder: '请选择业务类型', options: ['企业网络开通', '固定电话开通', '业务变更'] },
    { key: 'location', label: '安装位置', placeholder: '例如：A 座 1203 室' },
    { key: 'quantity', label: '工位或号码数量', placeholder: '请输入数量' },
    { key: 'expectedDate', label: '期望开通日期', placeholder: '例如：2026-08-05' },
    { key: 'contact', label: '联系人', placeholder: '请输入联系人姓名' },
  ],
  'meeting-room': [
    { key: 'company', label: '公司名称', placeholder: '请输入公司名称' },
    { key: 'attendees', label: '参会人数', placeholder: '请输入人数' },
    { key: 'contact', label: '联系人', placeholder: '请输入联系人姓名' },
    { key: 'phone', label: '联系电话', placeholder: '请输入联系电话' },
    { key: 'meetingContent', label: '会议内容', placeholder: '请简要填写会议主题或内容' },
  ],
  'electric-card': [
    { key: 'cardNumber', label: '电卡编号', placeholder: '请输入电卡编号' },
    { key: 'amount', label: '充值金额', placeholder: '请输入金额（元）' },
    { key: 'company', label: '公司名称', placeholder: '请输入公司名称' },
    { key: 'contact', label: '办理人', placeholder: '请输入办理人姓名' },
    { key: 'phone', label: '联系电话', placeholder: '请输入手机号码' },
  ],
  repair: [
    { key: 'location', label: '故障位置', placeholder: '例如：A 座 1203 室会议室' },
    { key: 'category', label: '报修类别', placeholder: '请选择报修类别', options: ['水电', '网络', '空调', '门禁', '其他'] },
    { key: 'issue', label: '故障描述', placeholder: '请说明发生了什么问题' },
    { key: 'urgency', label: '紧急程度', placeholder: '请选择紧急程度', options: ['普通', '紧急', '影响办公'] },
    { key: 'contact', label: '现场联系人', placeholder: '请输入联系人姓名' },
    { key: 'phone', label: '联系电话', placeholder: '请输入手机号码' },
  ],
  'vehicle-visit': [
    { key: 'visitor', label: '来访人', placeholder: '请输入来访人姓名' },
    { key: 'phone', label: '手机号', placeholder: '请输入来访人手机号' },
    { key: 'plate', label: '车牌号', placeholder: '例如：粤 B·D5678' },
    { key: 'visitTime', label: '来访日期与时间', placeholder: '例如：2026-08-05 15:00' },
    { key: 'reason', label: '拜访企业及事由', placeholder: '请填写拜访对象和事由' },
  ],
};

/**
 * 9 项正好形成 3 列 × 3 行，对应《客户服务工作流程》。steps 仅保留为服务说明；
 * 实际申请和状态都由企业服务器保存。
 */
function baseDefaultServices(park: string): ParkService[] {
  return [
    {
      id: 'announcement', icon: IconPackage, name: '园区公告', desc: '培训通知与全园区推送',
      prompt: `帮我起草一则${park}公告。公告类型（培训/活动/停水停电/其他）：；标题：；时间地点：；正文要点：；推送范围：`,
      demoSubject: '园区公告接收端',
    },
    {
      id: 'satisfaction', icon: IconUtensils, name: '满意度调查', desc: '问卷反馈与分析报告',
      prompt: `帮我填写${park}企业服务满意度调查。评价维度（客服/物业/网络/餐饮）：；总体评分：；改进建议：`,
      demoSubject: '2026 年第三季度企业服务满意度调查',
    },
    {
      id: 'renovation', icon: IconBuilding, name: '装修管理', desc: '提交装修申请至客服部',
      prompt: `帮我提交一条${park}装修申请。公司名称：；装修区域：；计划开工日期：；施工内容：；现场联系人：`,
      demoSubject: 'A 座 1203 室办公室装修申请',
      steps: [
        { role: '企业用户', owner: '当前申请人', detail: '填写并提交装修申请单。' },
        { role: '园区客服部', owner: '客服人员', detail: '接收申请单并主动联系企业，后续事项在线下办理。' },
      ],
    },
    {
      id: 'parking', icon: IconIdBadge, name: '停车位办理', desc: '车位申请与开通手续',
      prompt: `帮我提交${park}停车位办理申请。公司名称：；车牌号：；车辆类型：；申请数量：；联系人：`,
      demoSubject: '固定停车位开通申请 · 粤 B·A1234',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上提交停车位、车辆及联系人信息。' },
        { role: '专属客服', owner: '林晓', detail: '即时受理并联系企业确认车辆使用需求。' },
        { role: '车场管理员', owner: '李队', detail: '核验可用车位、车牌资料与车辆通行规则。' },
        { role: '企业与客服', owner: '线下办理', detail: '签署停车位开通手续，登记授权车辆。' },
        { role: '车场管理员', owner: '李队', detail: '完成门禁权限开通并通知企业验收。' },
      ],
    },
    {
      id: 'network-phone', icon: IconWrench, name: '网络与电话', desc: '宽带、固话开通与调试',
      prompt: `帮我提交${park}网络或电话业务申请。业务类型（网络/固定电话）：；安装位置：；工位数量或号码数量：；期望开通日期：；联系人：`,
      demoSubject: 'A 座 1203 室企业网络开通申请',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上提交网络/电话业务、安装位置和开通时间。' },
        { role: '专属客服', owner: '林晓', detail: '受理并联系企业确认业务需求明细。' },
        { role: '企业与客服', owner: '线下办理', detail: '完成业务协议签署及开通资料确认。' },
        { role: '网络工程师', owner: '张工', detail: '上门布线、安装设备并完成网络连通测试。' },
        { role: '网络工程师', owner: '张工', detail: '企业现场验收通过，业务开通完成。' },
      ],
    },
    {
      id: 'meeting-room', icon: IconCalendarCheck, name: '会议室预约', desc: '按人数、时段安排会议室',
      prompt: `帮我预订${park}会议室。参会人数：；日期：；时间段：；是否需要投屏/视频会议：；联系人：`,
      demoSubject: '周三 14:00–16:00 · 12 人会议室',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '按参会人数和使用时段提交会议室申请。' },
        { role: '专属客服', owner: '林晓', detail: '查询可用会议室并联系企业确认使用时间。' },
        { role: '会议服务专员', owner: '王敏', detail: '锁定会议室，核对投屏、视频会议等配套需求。' },
        { role: '企业与客服', owner: '线下办理', detail: '完成会议室使用手续确认。' },
        { role: '会议服务专员', owner: '王敏', detail: '预约成功，向企业发送会议室使用提醒。' },
      ],
    },
    {
      id: 'electric-card', icon: IconPackage, name: '电卡充电', desc: '电卡充值与余额确认',
      prompt: `帮我提交${park}电卡充电申请。电卡编号：；充值金额：；公司名称：；联系人：`,
      demoSubject: '电卡充值申请 · 500 元',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上提交电卡编号、充值金额和联系人。' },
        { role: '专属客服', owner: '林晓', detail: '即时受理并联系企业确认充值信息。' },
        { role: '能源服务专员', owner: '王敏', detail: '核验电卡状态，预约线下办理时间。' },
        { role: '企业用户', owner: '线下办理', detail: '携带电卡至客服中心完成充值手续。' },
        { role: '能源服务专员', owner: '王敏', detail: '写入余额、出具充值结果，流程办结。' },
      ],
    },
    {
      id: 'repair', icon: IconWrench, name: '客户报修', desc: '自动派单与上门维修',
      prompt: `帮我提交${park}客户报修工单。报修类别（网络/空调/水电/门禁/其他）：；故障位置：；故障描述：；紧急程度：；现场联系人：`,
      demoSubject: 'A 座 1203 室网络频繁断连',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '选择“网络故障”报修类别并提交现场问题。' },
        { role: '工单系统', owner: '自动派单', detail: '按报修类别将工单分配给网络维修主管。' },
        { role: '网络维修主管', owner: '张工', detail: '收到任务通知后应答确认，安排上门时段。' },
        { role: '网络维修人员', owner: '张工', detail: '到达现场排查交换机与线路，完成维修。' },
        { role: '企业用户', owner: '演示申请人', detail: '确认网络恢复，工单验收关单。' },
      ],
    },
    {
      id: 'vehicle-visit', icon: IconIdBadge, name: '来访车辆', desc: '访客车辆预约登记放行',
      prompt: `帮我登记${park}来访车辆。来访人：；手机号：；车牌号：；来访日期与时间：；拜访企业/事由：`,
      demoSubject: '来访车辆预约 · 粤 B·D5678',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上提供来访人、车牌、时间和拜访事由。' },
        { role: '专属客服', owner: '林晓', detail: '接收来访信息并完成初步核验。' },
        { role: '安保公司', owner: '李队', detail: '接收登记信息，安排访客车辆通行与停车指引。' },
        { role: '园区门岗', owner: '安保值班员', detail: '车辆到访时核验登记信息并放行，流程完成。' },
      ],
    },
  ];
}

function defaultServices(park: string, actors: ParkActorDirectory = {}): ParkService[] {
  return personalizeParkServices(baseDefaultServices(park), actors);
}

const PARK_OPEN_EVENT = 'otto:open-park-services';
const SERVER_PUBLICATION_SERVICE_IDS = new Set(['announcement', 'satisfaction']);

export function openParkServices(): void {
  window.dispatchEvent(new CustomEvent(PARK_OPEN_EVENT));
}

export function useParkBrand(): string {
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const enterpriseParkView = window.otto?.enterpriseParkView;
      if (typeof enterpriseParkView === 'function') {
        try {
          const park = await enterpriseParkView();
          if (!cancelled) {
            setBrand(park?.status === 'active' ? park.brandName?.trim() || DEFAULT_BRAND : DEFAULT_BRAND);
          }
        } catch {
          if (!cancelled) setBrand(DEFAULT_BRAND);
        }
        return;
      }
      // 只有旧 preload 根本没有中心园区 API 时，才保留本机配置兼容。
      const cfg = await window.otto?.parkConfig?.().catch(() => null);
      if (!cancelled) setBrand(cfg?.brandName || DEFAULT_BRAND);
    })();
    return () => { cancelled = true; };
  }, []);
  return brand;
}

function errorMessage(cause: unknown): string {
  const value = cause instanceof Error ? cause.message : String(cause);
  return value.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}

function AnnouncementView({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [items, setItems] = useState<EnterpriseParkPublication[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.otto.enterpriseParkPublications();
      setItems(next.filter((item) => item.kind === 'announcement'));
      setError(null);
    } catch (cause) { setError(errorMessage(cause)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { void refresh(); }, 5000); return () => window.clearInterval(timer); }, [refresh]);
  const openItem = async (item: EnterpriseParkPublication): Promise<void> => {
    setSelectedId(item.id);
    if (!item.readAt) {
      try {
        const next = await window.otto.enterpriseParkPublicationRead(item.id);
        setItems((current) => current.map((value) => value.id === next.id ? next : value));
      } catch (cause) { setError(errorMessage(cause)); }
    }
  };
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  return <div className="otto-park-demo">
    <div className="otto-park-demo__topline"><button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button><span className="otto-park-demo__status">{items.filter((item) => !item.readAt).length} 条未读</span></div>
    <div className="otto-park-demo__summary"><div><div className="otto-park-demo__eyebrow">园区通知</div><h3>园区公告</h3><p>查看园区发布的停水停电、活动和服务通知。</p></div></div>
    {error ? <div className="otto-park-form__receipt" role="alert">{error}</div> : null}
    {loading ? <div className="otto-park-repair__empty">正在读取公告…</div> : items.length ? <div className="otto-park-survey"><section className="otto-park-survey__publish" aria-label="公告列表"><div className="otto-park-repair__roles">{items.map((item) => <button key={item.id} type="button" className={selected?.id === item.id ? 'is-active' : ''} onClick={() => { void openItem(item); }}>{item.readAt ? '' : '新 · '}{item.title}</button>)}</div></section>{selected ? <section className="otto-park-announcement-detail" aria-label="公告详情"><div className="otto-park-receiver__label">{selected.readAt ? '已查看' : '未读公告'}</div><h3>{selected.title}</h3><p>{selected.body}</p><small>{new Date(selected.createdAt).toLocaleString('zh-CN')}</small></section> : null}</div> : <div className="otto-park-repair__empty">暂无园区公告。</div>}
  </div>;
}

function SatisfactionView({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [items, setItems] = useState<EnterpriseParkPublication[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [account, setAccount] = useState<EnterpriseAccount | null>(null);
  const [score, setScore] = useState('5');
  const [focus, setFocus] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [session, publications] = await Promise.all([window.otto.enterpriseSession(), window.otto.enterpriseParkPublications()]);
      setAccount(session.account);
      setItems(publications.filter((item) => item.kind === 'satisfaction'));
      setError(null);
    } catch (cause) { setError(errorMessage(cause)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selected || selected.submittedAt) return;
    setBusy(true); setError(null);
    try {
      const next = await window.otto.enterpriseParkSurveySubmit(selected.id, { score, focus, feedback, submittedBy: account?.name || '' });
      setItems((current) => current.map((item) => item.id === next.id ? next : item));
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  return <div className="otto-park-demo">
    <div className="otto-park-demo__topline"><button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button><span className={`otto-park-demo__status ${selected?.submittedAt ? 'is-done' : ''}`}>{selected?.submittedAt ? '已提交' : selected ? '待填写' : '暂无问卷'}</span></div>
    <div className="otto-park-demo__summary"><div><div className="otto-park-demo__eyebrow">实名反馈</div><h3>满意度调查</h3><p>每份问卷只能提交一次，提交后不能修改。</p></div></div>
    {error ? <div className="otto-park-form__receipt" role="alert">{error}</div> : null}
    {items.length ? <><div className="otto-park-repair__roles">{items.map((item) => <button key={item.id} type="button" className={selected?.id === item.id ? 'is-active' : ''} onClick={() => setSelectedId(item.id)}>{item.submittedAt ? '已提交 · ' : '待填写 · '}{item.title}</button>)}</div>{selected ? <form className="otto-park-survey__form" onSubmit={(event) => { void submit(event); }} aria-label="员工填写满意度调查"><div className="otto-park-receiver__label">提交人：{account?.name || '当前用户'}</div><h3>{selected.title}</h3><p>{selected.body}</p><label>总体满意度<select value={selected.responseData?.score || score} onChange={(event) => setScore(event.target.value)} disabled={Boolean(selected.submittedAt)}><option value="5">5 分 · 非常满意</option><option value="4">4 分 · 满意</option><option value="3">3 分 · 一般</option><option value="2">2 分 · 待改进</option><option value="1">1 分 · 不满意</option></select></label><label>重点关注<input required value={selected.responseData?.focus || focus} onChange={(event) => setFocus(event.target.value)} disabled={Boolean(selected.submittedAt)} placeholder="例如：网络响应、会议室环境" /></label><label>改进建议<textarea required rows={4} value={selected.responseData?.feedback || feedback} onChange={(event) => setFeedback(event.target.value)} disabled={Boolean(selected.submittedAt)} placeholder="请填写具体建议" /></label><button type="submit" className="otto-park-demo__primary" disabled={busy || Boolean(selected.submittedAt)}>{selected.submittedAt ? '已实名提交，不能修改' : busy ? '正在提交…' : '提交问卷'}</button></form> : null}</> : <div className="otto-park-repair__empty">暂无需要填写的满意度调查。</div>}
  </div>;
}

function futureLocalDate(offsetDays = 1): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ServiceRequestView({ service, onBack, focusTicket }: {
  service: ParkService;
  onBack: () => void;
  focusTicket: EnterpriseRepairTicket | null;
}): React.JSX.Element {
  const fields = SERVICE_FORM_FIELDS[service.id] ?? [];
  const interaction = SERVICE_INTERACTIONS[service.id] ?? {
    intro: `填写并提交${service.name}申请，园区客服受理后会返回办理结果。`,
    quickReplies: ['已受理', '需要补充材料', '已安排办理'],
    hint: '请准确填写信息，以便园区客服及时处理。',
  };
  const handlerMode = Boolean(focusTicket?.isRecipient);
  const [account, setAccount] = useState<EnterpriseAccount | null>(null);
  const [tickets, setTickets] = useState<EnterpriseRepairTicket[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(focusTicket?.id ?? null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<EnterpriseRepairTicket | null>(null);
  const [resources, setResources] = useState<EnterpriseParkResources | null>(null);
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(
    fields.map((field) => [field.key, ''])
      .concat([
        ['otherCategory', ''],
        ['roomId', ''],
        ['roomName', ''],
        ['date', futureLocalDate()],
        ['slotKey', ''],
        ['time', ''],
        ['roomCapacity', ''],
        ['priceHalfDay', ''],
      ]),
  ));
  const [response, setResponse] = useState({ type: '', text: '' });

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [session, next] = await Promise.all([
        window.otto.enterpriseSession(),
        window.otto.enterpriseTicketList(),
      ]);
      setAccount(session.account);
      setTickets(next.filter((ticket) => (
        ticket.serviceId === service.id || (service.id === 'repair' && !ticket.serviceId)
      )));
      setError(session.account ? null : '请先登录企业账号。');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [service.id]);

  const refreshResources = useCallback(async (): Promise<void> => {
    if (!['meeting-room', 'parking'].includes(service.id) || !window.otto?.enterpriseParkResources) {
      setResources(null);
      return;
    }
    try {
      setResources(await window.otto.enterpriseParkResources());
    } catch {
      setResources(null);
    }
  }, [service.id]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => { void refreshResources(); }, [refreshResources]);
  useEffect(() => {
    if (!account) return;
    setForm((current) => ({
      ...current,
      company: current.company || account.organizationName || '',
      contact: current.contact || account.name,
      phone: current.phone || account.phone?.replace(/^\+86/, '') || '',
    }));
  }, [account]);

  const selectedRoom = resources?.meetingRooms.find((room) => room.id === form.roomId) ?? null;
  const visibleSlots = resources?.meetingSlots.filter((slot) => (
    slot.roomId === form.roomId && slot.date === form.date
  )) ?? [];
  const attendeeCount = Number(form.attendees);
  const attendeeError = service.id === 'meeting-room' && form.attendees
    ? !Number.isInteger(attendeeCount) || attendeeCount < 1
      ? '参会人数只能填写大于等于 1 的整数'
      : selectedRoom && attendeeCount > selectedRoom.capacity
        ? `所选${selectedRoom.name}最多容纳 ${selectedRoom.capacity} 人`
        : null
    : null;
  const ownTickets = tickets.filter((ticket) => ticket.isCreator);
  const assignedTickets = tickets.filter((ticket) => ticket.isRecipient);
  const activeTicket = tickets.find((ticket) => ticket.id === selectedId)
    ?? (handlerMode ? assignedTickets[0] : ownTickets[0]) ?? null;

  const replaceTicket = (next: EnterpriseRepairTicket): void => {
    setTickets((current) => [next, ...current.filter((ticket) => ticket.id !== next.id)]);
    setSelectedId(next.id);
  };

  const chooseRoom = (roomId: string): void => {
    const room = resources?.meetingRooms.find((item) => item.id === roomId);
    setForm((current) => ({
      ...current,
      roomId,
      roomName: room?.name ?? '',
      roomCapacity: room ? String(room.capacity) : '',
      priceHalfDay: room ? String(room.priceHalfDay) : '',
      slotKey: '',
      time: '',
      attendees: room && Number(current.attendees) > room.capacity ? '' : current.attendees,
    }));
  };

  const chooseSlot = (slot: EnterpriseParkResources['meetingSlots'][number]): void => {
    if (slot.status !== 'available') return;
    setForm((current) => ({ ...current, slotKey: slot.slotKey, time: slot.label }));
  };

  const submitTicket = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const normalized = { ...form };
      if (service.id === 'meeting-room') {
        if (!selectedRoom) throw new Error('请从下拉菜单选择会议室');
        if (!normalized.date || normalized.date < futureLocalDate()) throw new Error('会议室只能预约未来日期');
        if (!normalized.slotKey) throw new Error('请选择一个绿色的可预约时段');
        if (!normalized.attendees || attendeeError) throw new Error(attendeeError || '请填写参会人数');
      }
      if (service.id === 'repair' && form.category === '其他') {
        normalized.category = form.otherCategory.trim() || '其他';
      }
      const primary = normalized.roomName || normalized.location || normalized.area
        || normalized.plate || normalized.date || normalized.cardNumber || normalized.visitor || service.name;
      const description = service.id === 'repair'
        ? normalized.issue
        : [
          ...(service.id === 'meeting-room'
            ? [
              `会议室：${normalized.roomName}`,
              `使用日期：${normalized.date}`,
              `使用时间：${normalized.time}`,
              `费用：${normalized.priceHalfDay} 元/半天`,
            ]
            : []),
          ...fields.map((field) => `${field.label}：${normalized[field.key] || ''}`),
        ].join('\n');
      const next = await window.otto.enterpriseTicketSubmit({
        serviceId: service.id,
        title: service.id === 'repair'
          ? `${primary} · ${normalized.category}报修`
          : `${service.name} · ${primary}`,
        description,
        formData: normalized,
        category: service.id === 'repair' ? normalized.category : undefined,
        location: service.id === 'repair' ? normalized.location : undefined,
        urgency: service.id === 'repair' ? normalized.urgency : undefined,
        contact: normalized.contact,
        contactPhone: normalized.phone,
      });
      setReceipt(next);
      replaceTicket(next);
      await refreshResources();
      if (service.id !== 'meeting-room') {
        setForm(Object.fromEntries(fields.map((field) => [
          field.key,
          field.key === 'contact' ? account?.name || ''
            : field.key === 'phone' ? account?.phone?.replace(/^\+86/, '') || ''
              : field.key === 'company' ? account?.organizationName || '' : '',
        ]).concat([
          ['otherCategory', ''],
          ['roomId', ''],
          ['roomName', ''],
          ['date', futureLocalDate()],
          ['slotKey', ''],
          ['time', ''],
          ['roomCapacity', ''],
          ['priceHalfDay', ''],
        ])));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const action = async (
    ticket: EnterpriseRepairTicket,
    actionName: 'respond' | 'accept' | 'complete' | 'confirm',
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.otto.enterpriseTicketAction(ticket.id, {
        action: actionName,
        ...(actionName === 'respond'
          ? { responseType: response.type, responseText: response.text }
          : {}),
      });
      replaceTicket(next);
      if (actionName === 'respond') setResponse({ type: '', text: '' });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const openAssigned = async (ticket: EnterpriseRepairTicket): Promise<void> => {
    setSelectedId(ticket.id);
    if (!ticket.readAt) {
      try {
        replaceTicket(await window.otto.enterpriseTicketRead(ticket.id));
      } catch { /* 后续轮询重试 */ }
    }
  };

  if (loading) {
    return <div className="otto-park-demo"><div className="otto-park-repair__empty">正在读取园区服务…</div></div>;
  }
  if (!account) {
    return <div className="otto-park-demo">
      <div className="otto-park-demo__topline"><button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button></div>
      <div className="otto-park-repair__empty">{error || '请先登录企业账号。'}</div>
    </div>;
  }

  return <div className="otto-park-demo">
    <div className="otto-park-demo__topline">
      <button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button>
      <span className={`otto-park-demo__status ${activeTicket?.status === '已完成' ? 'is-done' : ''}`}>
        {activeTicket?.status || (handlerMode ? '待处理' : '可提交')}
      </span>
    </div>
    <div className="otto-park-demo__summary">
      <div>
        <div className="otto-park-demo__eyebrow">{handlerMode ? '园区服务待办' : '园区服务申请'}</div>
        <h3>{service.name}</h3>
        <p>{handlerMode ? '请核对用户提交的信息，并返回明确的办理结果。' : interaction.intro}</p>
      </div>
    </div>
    {error ? <div className="otto-park-form__receipt" role="alert">{error}</div> : null}

    {!handlerMode ? <>
      {service.id === 'meeting-room' && receipt ? <section className="otto-park-meeting-success" role="status">
        <span>预约申请已提交</span>
        <h3>{form.roomName} · {form.date}</h3>
        <p>{form.time}，{form.attendees} 人，费用 {form.priceHalfDay} 元/半天。</p>
        <p>申请单已经投递给园区客服人员，当前时段已变为红色“已预约”。</p>
        <button type="button" className="otto-park-demo__primary" onClick={onBack}>完成并关闭表单</button>
      </section> : <form className="otto-park-request-form" onSubmit={(event) => { void submitTicket(event); }} aria-label={`${service.name}申请表`}>
        <div className="otto-park-form__guide">
          <strong>填写申请</strong>
          <span>{service.id === 'meeting-room' ? '按顺序选择会议室、日期和绿色可预约时段。红色表示该时段已经被占用。' : interaction.hint}</span>
        </div>
        {service.id === 'parking' && resources ? <div className="otto-park-resource-note">
          <strong>园区总车位：{resources.settings.parkingTotal} 个</strong>
          <span>{resources.settings.parkingNote || '具体可办理车位由园区客服确认。'}</span>
        </div> : null}

        {service.id === 'meeting-room' ? <div className="otto-park-meeting-booking">
          <label className="otto-park-form__field">会议室名称
            <select aria-label="会议室名称" required value={form.roomId} onChange={(event) => chooseRoom(event.target.value)}>
              <option value="">请选择会议室</option>
              {resources?.meetingRooms.map((room) => <option key={room.id} value={room.id}>
                {room.name}（{room.capacity} 人，{room.priceHalfDay} 元/半天）
              </option>)}
            </select>
          </label>
          {selectedRoom ? <div className="otto-park-meeting-room-detail">
            <img src={selectedRoom.imageUrl || defaultMeetingRoomImage} alt={`${selectedRoom.name}照片`} />
            <div>
              <strong>{selectedRoom.name}</strong>
              <span>{selectedRoom.location} · 最多 {selectedRoom.capacity} 人</span>
              <span>{selectedRoom.priceHalfDay} 元/半天 · {selectedRoom.openingHours || '开放时间待确认'}</span>
            </div>
          </div> : null}
          <label className="otto-park-form__field">使用日期
            <input
              aria-label="使用日期"
              type="date"
              required
              min={futureLocalDate()}
              max={futureLocalDate(30)}
              value={form.date}
              onChange={(event) => setForm((current) => ({
                ...current,
                date: event.target.value,
                slotKey: '',
                time: '',
              }))}
            />
          </label>
          <fieldset className="otto-park-meeting-slots">
            <legend>使用时间</legend>
            {!form.roomId ? <p>请先选择会议室</p> : visibleSlots.length ? visibleSlots.map((slot) => <button
              key={slot.id}
              type="button"
              disabled={slot.status !== 'available'}
              className={`is-${slot.status} ${form.slotKey === slot.slotKey ? 'is-selected' : ''}`}
              onClick={() => chooseSlot(slot)}
            >
              <strong>{slot.label}</strong>
              <span>{slot.status === 'available' ? '可预约' : slot.status === 'booked' ? '已预约' : '未开放'}</span>
            </button>) : <p>该日期暂时没有园区发布的可预约时段</p>}
            <div className="otto-park-meeting-legend">
              <span className="is-available">绿色 · 可预约</span>
              <span className="is-booked">红色 · 已预约</span>
            </div>
          </fieldset>
        </div> : null}

        <div className="otto-park-form__grid">
          {fields.map((field) => <React.Fragment key={field.key}>
            <label className={`otto-park-form__field ${field.key === 'meetingContent' ? 'is-wide' : ''}`}>
              {field.label}
              {field.options ? <select
                aria-label={field.label}
                required
                value={form[field.key] || ''}
                onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
              >
                <option value="">{field.placeholder}</option>
                {field.options.map((option) => <option key={option}>{option}</option>)}
              </select> : field.key === 'meetingContent' ? <textarea
                aria-label={field.label}
                required
                rows={3}
                value={form[field.key] || ''}
                placeholder={field.placeholder}
                onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
              /> : <input
                aria-label={field.label}
                required
                type={service.id === 'meeting-room' && field.key === 'attendees' ? 'number' : 'text'}
                min={service.id === 'meeting-room' && field.key === 'attendees' ? 1 : undefined}
                max={service.id === 'meeting-room' && field.key === 'attendees' && selectedRoom ? selectedRoom.capacity : undefined}
                step={service.id === 'meeting-room' && field.key === 'attendees' ? 1 : undefined}
                value={form[field.key] || ''}
                placeholder={field.placeholder}
                onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
              />}
              {field.key === 'attendees' && selectedRoom
                ? <small className={attendeeError ? 'is-error' : ''}>{attendeeError || `最多可填写 ${selectedRoom.capacity} 人`}</small>
                : null}
            </label>
            {service.id === 'repair' && field.key === 'category' && form.category === '其他' ? <label className="otto-park-form__field">
              请填写其他类别
              <input aria-label="请填写其他类别" required value={form.otherCategory || ''} placeholder="例如：玻璃门损坏" onChange={(event) => setForm((current) => ({ ...current, otherCategory: event.target.value }))} />
            </label> : null}
          </React.Fragment>)}
        </div>
        <button
          type="submit"
          className="otto-park-demo__primary"
          disabled={busy || (service.id === 'meeting-room' && (!form.roomId || !form.slotKey || Boolean(attendeeError)))}
        >
          {busy ? '正在提交…' : `提交${service.name}申请`}
        </button>
        {receipt ? <div className="otto-park-form__receipt">
          {service.id === 'renovation'
            ? '装修申请已提交给园区客服部。客服人员收到申请单后会主动与您联系。'
            : '申请已提交，园区服务中心正在安排工作人员。可在下方“我的办理进度”中查看结果。'}
        </div> : null}
      </form>}

      {service.id !== 'renovation' && ownTickets.length ? <div className="otto-park-technician-form">
        <div className="otto-park-form__guide"><strong>我的办理进度</strong><span>这里只显示你自己提交的申请。</span></div>
        <div className="otto-park-repair__roles">{ownTickets.slice(0, 8).map((ticket) => <button key={ticket.id} type="button" className={activeTicket?.id === ticket.id ? 'is-active' : ''} onClick={() => setSelectedId(ticket.id)}>{ticket.title} · {ticket.status}</button>)}</div>
        {activeTicket?.isCreator ? <>
          <div className="otto-park-request-summary">
            <div><span>申请编号</span><strong>{activeTicket.id.slice(-8).toUpperCase()}</strong></div>
            <div><span>状态</span><strong>{activeTicket.status}</strong></div>
            <div><span>办理回复</span><strong>{activeTicket.responseType || '等待受理'}</strong></div>
            <div><span>说明</span><strong>{activeTicket.responseText || '暂无'}</strong></div>
          </div>
          {activeTicket.status === '待验收' ? <button type="button" className="otto-park-demo__primary" disabled={busy} onClick={() => { void action(activeTicket, 'confirm'); }}>确认办理完成</button> : null}
        </> : null}
      </div> : null}
    </> : <div className="otto-park-technician-form">
      <div className="otto-park-form__guide">
        <strong>{service.id === 'repair' ? '维修待办' : '客服待办'}</strong>
        <span>这里仅显示分配给当前账号的真实申请。</span>
      </div>
      {assignedTickets.length ? <>
        <div className="otto-park-repair__roles">{assignedTickets.map((ticket) => <button key={ticket.id} type="button" className={activeTicket?.id === ticket.id ? 'is-active' : ''} onClick={() => { void openAssigned(ticket); }}>{ticket.title} · {ticket.status}{!ticket.readAt ? ' · 新' : ''}</button>)}</div>
        {activeTicket?.isRecipient ? <>
          <div className="otto-park-request-summary">
            <div><span>申请人</span><strong>{activeTicket.creator.name}</strong></div>
            {Object.entries(activeTicket.formData).filter(([key]) => !['otherCategory', 'roomId'].includes(key)).map(([key, value]) => <div key={key}>
              <span>{key === 'roomName' ? '会议室' : fields.find((field) => field.key === key)?.label || key}</span>
              <strong>{value || '未填写'}</strong>
            </div>)}
          </div>
          <form className="otto-park-response-form" onSubmit={(event) => { event.preventDefault(); void action(activeTicket, 'respond'); }} aria-label="园区服务回复表">
            <label className="otto-park-form__field">处理方式
              <select required value={response.type} onChange={(event) => setResponse((current) => ({ ...current, type: event.target.value }))}>
                <option value="">请选择处理方式</option>
                {interaction.quickReplies.map((reply) => <option key={reply}>{reply}</option>)}
              </select>
            </label>
            <label className="otto-park-form__field">给申请人的说明
              <textarea required rows={4} value={response.text} onChange={(event) => setResponse((current) => ({ ...current, text: event.target.value }))} placeholder="请说明下一步安排、需要补充的信息或处理结果" />
            </label>
            <button type="submit" className="otto-park-demo__primary" disabled={busy || !response.type || !response.text.trim()}>发送办理回复</button>
          </form>
          <div className="otto-park-demo__actions">
            <button type="button" className="otto-park-demo__secondary" onClick={() => { void action(activeTicket, 'accept'); }} disabled={busy || !['待派单', '待接单'].includes(activeTicket.status)}>接单并处理</button>
            <button type="button" className="otto-park-demo__primary" onClick={() => { void action(activeTicket, 'complete'); }} disabled={busy || !['维修中', '处理中'].includes(activeTicket.status)}>提交办理完成</button>
          </div>
        </> : null}
      </> : <div className="otto-park-repair__empty">当前没有分配给你的待办。</div>}
    </div>}
  </div>;
}

function ServiceDemo({ service, onBack, focusTicket }: { service: ParkService; onBack: () => void; focusTicket: EnterpriseRepairTicket | null }): React.JSX.Element {
  if (service.id === 'announcement') return <AnnouncementView onBack={onBack} />;
  if (service.id === 'satisfaction') return <SatisfactionView onBack={onBack} />;
  return <ServiceRequestView service={service} onBack={onBack} focusTicket={focusTicket} />;
}

export function ParkServicesPlugin(): React.JSX.Element {
  const [parkEnabled, setParkEnabled] = useState(true);
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  const [services, setServices] = useState<ParkService[]>(() => defaultServices(DEFAULT_PARK));
  const [selected, setSelected] = useState<ParkService | null>(null);
  const [backgroundTickets, setBackgroundTickets] = useState<EnterpriseRepairTicket[]>([]);
  const [backgroundPublication, setBackgroundPublication] = useState<EnterpriseParkPublication | null>(null);
  const [focusTicket, setFocusTicket] = useState<EnterpriseRepairTicket | null>(null);
  const [assignedTasks, setAssignedTasks] = useState<EnterpriseRepairTicket[]>([]);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const notifiedTicketKeys = useRef(new Set<string>());
  const notifiedPublicationKeys = useRef(new Set<string>());
  const uid = useId();
  const titleId = `${uid}-title`;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const enterpriseParkView = window.otto?.enterpriseParkView;
      if (typeof enterpriseParkView === 'function') {
        try {
          const park = await enterpriseParkView();
          if (!park || park.status !== 'active') {
            if (!cancelled) {
              setParkEnabled(true);
              setBrand(DEFAULT_BRAND);
              setServices(defaultServices(DEFAULT_PARK));
            }
            return;
          }
          if (!cancelled) {
            setParkEnabled(true);
            setBrand(park.brandName || DEFAULT_BRAND);
            const defaults = defaultServices(park.name || DEFAULT_PARK);
            if (park.services?.length) {
              const configured = new Map(park.services.map((service) => [service.id, service]));
              setServices(defaults
                .filter((service) => configured.get(service.id)?.enabled !== false)
                .map((service) => {
                  const persisted = configured.get(service.id);
                  return {
                    ...service,
                    name: persisted?.name || service.name,
                    desc: persisted?.config.desc || service.desc,
                    prompt: persisted?.config.prompt || service.prompt,
                  };
                }));
            } else {
              setServices(defaults);
            }
          }
        } catch {
          if (!cancelled) {
            setParkEnabled(true);
            setBrand(DEFAULT_BRAND);
            setServices(defaultServices(DEFAULT_PARK));
          }
        }
        return;
      }
      // 旧 preload 兼容：没有 enterpriseParkView 时才允许本机园区配置。
      const cfg = await window.otto?.parkConfig?.().catch(() => null);
      if (cancelled || !cfg) return;
      setParkEnabled(true);
      if (cfg.brandName) setBrand(cfg.brandName);
      if (cfg.services && cfg.services.length > 0) {
        setServices(cfg.services.map((service, index) => ({
          id: `custom-${index}`,
          icon: ICON_POOL[index % ICON_POOL.length],
          name: service.name,
          desc: service.desc,
          prompt: service.prompt,
        })));
      } else if (cfg.parkName) {
        setServices(defaultServices(cfg.parkName));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (parkEnabled !== true) return undefined;
    if (!window.otto?.enterpriseParkPublications) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const publications = await window.otto.enterpriseParkPublications();
        if (cancelled) return;
        const candidate = publications.find(
          (item) => !item.readAt && !item.submittedAt && !notifiedPublicationKeys.current.has(item.id),
        );
        if (!candidate) return;
        notifiedPublicationKeys.current.add(candidate.id);
        setBackgroundPublication(candidate);
        void window.otto.parkNativeNotify?.(
          candidate.kind === 'announcement' ? 'Otto 园区公告' : 'Otto 满意度调查',
          `${candidate.title} · 点击查看`,
        );
      } catch {
        // 未登录或服务器暂不可达时等待下一次轮询。
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [parkEnabled]);

  useEffect(() => {
    if (open && !selected) firstItemRef.current?.focus();
  }, [open, selected]);

  useEffect(() => {
    const onOpen = (): void => {
      if (parkEnabled !== true) return;
      setSelected(null);
      setFocusTicket(null);
      setOpen(true);
    };
    window.addEventListener(PARK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(PARK_OPEN_EVENT, onOpen);
  }, [parkEnabled]);

  useEffect(() => {
    if (parkEnabled !== true) return undefined;
    if (!window.otto?.enterpriseSession || !window.otto?.enterpriseTicketList) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const session = await window.otto.enterpriseSession();
        if (cancelled) return;
        if (!session.account) {
          setAssignedTasks([]);
          return;
        }
        const tickets = await window.otto.enterpriseTicketList();
        if (cancelled) return;
        setAssignedTasks(tickets.filter(
          (ticket) => ticket.isRecipient && ticket.status !== '已完成',
        ));
        const candidates = [
          ...tickets.filter((ticket) => (
          ticket.isRecipient
          && !ticket.readAt
          && !notifiedTicketKeys.current.has(`assigned:${ticket.id}`)
          )),
          ...tickets.filter((ticket) => (
          ticket.isCreator
          && Boolean(ticket.responseAt || ticket.status === '待验收')
          && !notifiedTicketKeys.current.has(`updated:${ticket.id}:${ticket.updatedAt}`)
          )),
        ];
        if (!candidates.length) return;
        for (const candidate of candidates) {
          const key = candidate.isRecipient && !candidate.readAt
            ? `assigned:${candidate.id}`
            : `updated:${candidate.id}:${candidate.updatedAt}`;
          notifiedTicketKeys.current.add(key);
          const title = candidate.isRecipient && !candidate.readAt
            ? 'Otto 待处理提醒 · 园区服务'
            : 'Otto 园区服务进度提醒';
          const body = candidate.isRecipient && !candidate.readAt
            ? `${candidate.creator.name}：${candidate.location || candidate.title} · ${candidate.description}`
            : `${candidate.location || candidate.title} · ${candidate.responseType || candidate.status}`;
          const notify = window.otto.notificationShow?.({
            messageId: `park-ticket:${candidate.id}:${candidate.updatedAt}`,
            sessionId: `park:ticket:${candidate.id}`,
            source: 'park',
            title,
            sender: candidate.isRecipient ? candidate.creator.name : undefined,
            preview: body,
          });
          if (notify) {
            void notify.catch(() => {
              void window.otto.parkNativeNotify?.(title, body);
            });
          } else {
            void window.otto.parkNativeNotify?.(title, body);
          }
        }
        setBackgroundTickets((current) => [
          ...candidates,
          ...current.filter((ticket) => !candidates.some((candidate) => candidate.id === ticket.id)),
        ].slice(0, 5));
      } catch {
        // 未登录、服务器暂不可达时安静重试；报修页打开后会显示具体错误。
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [parkEnabled]);

  const close = (): void => { setSelected(null); setFocusTicket(null); setOpen(false); };
  const pick = (service: ParkService): void => {
    // 企业通过 park-services.json 配置的临时服务没有本地流程定义，保持原有
    // “注入 Otto 输入框”的兼容行为。
    if (!service.steps && !SERVER_PUBLICATION_SERVICE_IDS.has(service.id)) {
      insertComposerDraft(service.prompt);
      close();
      return;
    }
    setFocusTicket(null);
    setSelected(service);
  };

  const openTicket = (ticket: EnterpriseRepairTicket): void => {
    const service = services.find((item) => item.id === (ticket.serviceId || 'repair'))
      ?? services.find((item) => item.id === 'repair');
    if (service) {
      setFocusTicket(ticket);
      setSelected(service);
      setOpen(true);
    }
  };

  const openBackgroundTicket = (ticket: EnterpriseRepairTicket): void => {
    openTicket(ticket);
    setBackgroundTickets((current) => current.filter((item) => item.id !== ticket.id));
    void window.otto.notificationMarkRead?.(`park:ticket:${ticket.id}`).catch(() => undefined);
  };

  const openBackgroundPublication = (): void => {
    const serviceId = backgroundPublication?.kind;
    const service = services.find((item) => item.id === serviceId);
    if (service) {
      setFocusTicket(null);
      setSelected(service);
      setOpen(true);
    }
    setBackgroundPublication(null);
  };

  if (parkEnabled !== true) return <></>;

  return <>
  {open ? (
    <div
      className="otto-park-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
    >
      <div className="otto-park-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(e) => e.stopPropagation()}>
        <div className="otto-park-dialog__head">
          <span className="otto-park-dialog__headicon" aria-hidden><IconBuilding size={19} /></span>
          <div className="otto-park-dialog__headtext">
            <h2 className="otto-park-dialog__title" id={titleId}>{selected ? selected.name : brand}</h2>
            <div className="otto-park-dialog__subtitle">
              {selected?.id === 'announcement'
                ? '查看园区发布的最新通知和历史公告。'
                : selected?.id === 'satisfaction'
                  ? '实名填写园区发布的调查问卷，提交后不能修改。'
                  : selected?.id === 'repair'
                    ? '提交报修、查看进度，并确认最终维修结果。'
                  : selected
                    ? '提交服务申请后，可在这里查看受理进度和办理结果。'
                    : '选择需要办理的园区服务。'}
            </div>
          </div>
          <button type="button" className="otto-park-dialog__close" onClick={close} aria-label="关闭"><IconClose size={14} /></button>
        </div>
        {selected ? (
          <ServiceDemo service={selected} onBack={() => { setSelected(null); setFocusTicket(null); }} focusTicket={focusTicket} />
        ) : (
          <div className="otto-park-dialog__landing">
            {assignedTasks.length ? <section className="otto-park-staff-tasks" aria-label="我的园区待办">
              <div><strong>我的园区待办</strong><span>{assignedTasks.length} 项待处理 · 仅工作人员可见</span></div>
              <div className="otto-park-staff-tasks__items">{assignedTasks.slice(0, 3).map((ticket) => <button key={ticket.id} type="button" onClick={() => openTicket(ticket)} aria-label={`打开工作人员待办：${ticket.title}`}><span>{ticket.title}</span><em>{ticket.status} {!ticket.readAt ? '· 新' : ''}</em></button>)}</div>
            </section> : null}
            <div className="otto-park-dialog__grid">
              {services.map((service, index) => {
                const Icon = service.icon;
                return (
                  <button key={service.id} ref={index === 0 ? firstItemRef : undefined} type="button" className="otto-park-service" onClick={() => pick(service)}>
                    <span className="otto-park-service__icon" aria-hidden><Icon size={17} /></span>
                    <span className="otto-park-service__name">{service.name}</span>
                    <span className="otto-park-service__desc">{service.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  ) : null}
  {(backgroundTickets.length || backgroundPublication) ? <div className="otto-park-toast-stack" aria-live="polite">
    {backgroundTickets.map((ticket) => (
      <button key={ticket.id} type="button" className="otto-park-toast otto-park-toast--result" onClick={() => openBackgroundTicket(ticket)} aria-label={`打开园区服务通知：${ticket.title}`}>
        <span>Otto 园区服务</span>
        <strong>{ticket.isRecipient && !ticket.readAt ? '收到新的待处理申请' : '你的园区服务申请有新进展'}</strong>
        <em>{ticket.title} · {ticket.status} · 点击查看</em>
      </button>
    ))}
    {backgroundPublication ? <button type="button" className="otto-park-toast" onClick={openBackgroundPublication} aria-label="打开园区通知"><span>{backgroundPublication.kind === 'announcement' ? '园区公告' : '满意度调查'}</span><strong>{backgroundPublication.title}</strong><em>点击查看</em></button> : null}
  </div> : null}
  </>;
}
