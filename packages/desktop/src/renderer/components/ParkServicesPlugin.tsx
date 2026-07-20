/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 宏创 AI 园区服务入口。
 *
 * 客户报修已接入企业服务器：按管理员指定的维修工作人员自动投递，并用结构化
 * 处理表完成接单、回复、维修、验收。其余园区服务暂保留既有演示流程。
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { insertComposerDraft } from './Composer.js';
import type { EnterpriseAccount, EnterpriseRepairTicket } from '../../preload/index.js';
import {
  IconBuilding,
  IconCalendarCheck,
  IconCheck,
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

const DEFAULT_BRAND = '宏创AI园区服务';
const DEFAULT_PARK = '宏创园区';
const NOTIFICATION_TIMEOUT_MS = 12000;
const ANNOUNCEMENT_TOAST_TIMEOUT_MS = 9000;

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

interface ParkAccountCandidate {
  id: string;
  username: string;
  name: string;
  role: string | null;
  department: string | null;
  isAdmin: boolean;
  status: 'active' | 'disabled';
}

function accountMatches(account: ParkAccountCandidate, words: string[]): boolean {
  const haystack = [
    account.username,
    account.name,
    account.role,
    account.department,
  ].join(' ').toLowerCase();
  return words.some((word) => haystack.includes(word.toLowerCase()));
}

function pickAccount(
  accounts: ParkAccountCandidate[],
  words: string[],
  fallback?: ParkAccountCandidate,
): string | undefined {
  return accounts.find((account) => account.status === 'active' && accountMatches(account, words))?.name
    ?? fallback?.name;
}

function buildParkActorDirectory(
  currentUser: string | undefined,
  accounts: ParkAccountCandidate[],
): ParkActorDirectory {
  const active = accounts.filter((account) => account.status === 'active');
  const admin = active.find((account) => account.isAdmin);
  const serviceDesk = active.find((account) => accountMatches(account, ['客服', '客户成功', '服务']));
  const repairer = active.find((account) => accountMatches(account, ['维修', '报修', 'IT', '网络', '工程']));
  return {
    currentUser,
    admin: admin?.name,
    serviceDesk: serviceDesk?.name ?? admin?.name,
    repairer: repairer?.name,
    operator: pickAccount(active, ['运营', '物业'], serviceDesk ?? admin),
    parking: pickAccount(active, ['车场', '停车', '安保'], serviceDesk ?? admin),
    meeting: pickAccount(active, ['会议', '会务', '行政'], serviceDesk ?? admin),
    energy: pickAccount(active, ['能源', '电卡', '水电', '物业'], serviceDesk ?? admin),
    security: pickAccount(active, ['安保', '门岗', '访客'], serviceDesk ?? admin),
  };
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
  renovation: { intro: '装修申请先核对施工范围，再约现场交底；不完整的材料会直接告诉你缺什么。', quickReplies: ['信息已确认，安排现场交底', '需要补充施工方案', '暂时没空，明天下午联系'], hint: '装修通常需要材料确认和现场时间，不建议只用一个“完成”按钮。' },
  parking: { intro: '停车办理先核验车牌和车位，再确认门禁开通时间。', quickReplies: ['车牌信息确认', '请帮我查可用车位', '我晚点补充车辆资料'], hint: '车场管理员可以先查位，企业无需反复电话确认。' },
  'network-phone': { intro: '网络/电话申请先确认安装位置和开通日期；工程师也可以先远程指导自查。', quickReplies: ['需求确认，请安排开通', '请远程指导自查线路', '安排工程师上门'], hint: '能远程排除的问题先在线处理，减少工程师无效上门。' },
  'meeting-room': { intro: '会议室预约会先核对人数、时段和设备；如果冲突，客服会给出替代时段。', quickReplies: ['时间人数确认', '帮我换一个会议室', '需要投屏/视频会议'], hint: '预约不是单向提交，冲突时要能直接换房或补充设备。' },
  'electric-card': { intro: '电卡办理先核验卡号和金额，再提示到客服中心的办理时间。', quickReplies: ['充值信息确认', '请核验电卡余额', '我稍后到客服中心'], hint: '金额和卡号需要二次确认，避免错充。' },
  'vehicle-visit': { intro: '来访车辆先登记人、车牌和时间；安保端会收到放行信息，改期也可直接留言。', quickReplies: ['登记信息确认', '访客改期', '请告知门岗放行规则'], hint: '访客信息有变化时直接回复即可，不必重新打电话。' },
};

const SERVICE_FORM_FIELDS: Record<string, Array<{ label: string; value: string; type?: 'text' | 'select' }>> = {
  renovation: [{ label: '装修区域', value: 'A 座 1203 室' }, { label: '计划开工', value: '2026-08-01' }, { label: '施工联系人', value: '演示申请人' }],
  parking: [{ label: '车牌号', value: '粤 B·A1234' }, { label: '车辆类型', value: '小型客车' }, { label: '申请数量', value: '1 个' }],
  'network-phone': [{ label: '业务类型', value: '网络' }, { label: '安装位置', value: 'A 座 1203 室' }, { label: '期望开通', value: '2026-08-05' }],
  'meeting-room': [{ label: '使用时间', value: '周三 14:00–16:00' }, { label: '参会人数', value: '12 人' }, { label: '设备需求', value: '投屏' }],
  'electric-card': [{ label: '电卡编号', value: 'HC-2026-001' }, { label: '充值金额', value: '500 元' }, { label: '办理人', value: '演示申请人' }],
  'vehicle-visit': [{ label: '来访人', value: '李明' }, { label: '车牌号', value: '粤 B·D5678' }, { label: '来访时间', value: '今天 15:00' }],
};

/**
 * 9 项正好形成 3 列 × 3 行，对应《客户服务工作流程》。每一条 steps 都是
 * 本地演示数据，真实服务端接入后可替换为工单状态流。
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
      id: 'renovation', icon: IconBuilding, name: '装修管理', desc: '装修申请与进场协调',
      prompt: `帮我提交一条${park}装修申请。公司名称：；装修区域：；计划开工日期：；施工内容：；现场联系人：`,
      demoSubject: 'A 座 1203 室办公室装修申请',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上提交装修申请、施工范围与联系人。' },
        { role: '专属客服', owner: '林晓', detail: '受理申请并主动联系企业核对装修需求。' },
        { role: '园区运营', owner: '王敏', detail: '安排现场交底，准备装修协议与施工要求。' },
        { role: '企业与客服', owner: '线下办理', detail: '完成装修协议协商、签署和盖章。' },
        { role: '物业主管', owner: '陈工', detail: '确认进场条件，发放施工进场指引，流程办结。' },
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
const LOCAL_DEMO_SERVICE_IDS = new Set(['announcement', 'satisfaction']);

export function openParkServices(): void {
  window.dispatchEvent(new CustomEvent(PARK_OPEN_EVENT));
}

export function useParkBrand(): string {
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  useEffect(() => {
    let cancelled = false;
    void window.otto?.parkConfig?.().then((cfg) => {
      if (!cancelled && cfg?.brandName) setBrand(cfg.brandName);
    });
    return () => { cancelled = true; };
  }, []);
  return brand;
}

function AnnouncementDemo({ onBack, onSendToOtto }: {
  onBack: () => void;
  onSendToOtto: () => void;
}): React.JSX.Element {
  const [toastOpen, setToastOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [read, setRead] = useState(false);
  const announcement = {
    title: '下午临时停水通知',
    time: '今天 14:00–16:00',
    scope: 'A 座、B 座企业用户',
    body: '因生活水泵房临时检修，园区将在下午短暂停水。请企业提前储备用水，茶水间与卫生间将在恢复后统一巡检。',
    contact: '园区客服中心 · 400-800-8899',
  };

  useEffect(() => {
    if (!toastOpen) return;
    const timer = window.setTimeout(() => setToastOpen(false), ANNOUNCEMENT_TOAST_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [toastOpen]);

  const receive = (): void => {
    setDetailOpen(false);
    setRead(false);
    setToastOpen(true);
  };

  const viewDetail = (): void => {
    setToastOpen(false);
    setDetailOpen(true);
    setRead(true);
  };

  return (
    <div className="otto-park-demo">
      <div className="otto-park-demo__topline">
        <button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button>
        <span className={`otto-park-demo__status ${read ? 'is-done' : ''}`}>{read ? '已查看公告' : toastOpen ? '右下角待查看' : '等待园区发布'}</span>
      </div>
      <div className="otto-park-demo__summary">
        <div>
          <div className="otto-park-demo__eyebrow">本地模拟公告 · Otto 只作为企业接收端</div>
          <h3>{announcement.title}</h3>
          <p>园区管理员从服务端口发布后，企业侧 Otto 右下角弹窗提醒，员工点击即可查看详情。</p>
        </div>
        <button type="button" className="otto-park-demo__chat" onClick={onSendToOtto}>改用 Otto 起草</button>
      </div>
      <div className="otto-park-receiver">
        <div className="otto-park-receiver__panel">
          <div className="otto-park-receiver__label">园区端模拟输入</div>
          <h3>{announcement.title}</h3>
          <p>{announcement.body}</p>
          <dl>
            <div><dt>影响时间</dt><dd>{announcement.time}</dd></div>
            <div><dt>推送范围</dt><dd>{announcement.scope}</dd></div>
            <div><dt>咨询方式</dt><dd>{announcement.contact}</dd></div>
          </dl>
          <button type="button" className="otto-park-demo__primary" onClick={receive}>模拟园区发布公告</button>
        </div>
        <div className="otto-park-receiver__state" aria-live="polite">
          <span>{read ? '已读回执已记录' : toastOpen ? '公告已送达 Otto，等待员工点击查看' : '暂无新公告'}</span>
        </div>
      </div>
      {detailOpen ? (
        <div className="otto-park-announcement-detail" role="status">
          <div className="otto-park-receiver__label">公告详情</div>
          <h3>{announcement.title}</h3>
          <p>{announcement.body}</p>
          <dl>
            <div><dt>影响时间</dt><dd>{announcement.time}</dd></div>
            <div><dt>推送范围</dt><dd>{announcement.scope}</dd></div>
            <div><dt>咨询方式</dt><dd>{announcement.contact}</dd></div>
          </dl>
        </div>
      ) : null}
      {toastOpen ? (
        <button type="button" className="otto-park-toast" onClick={viewDetail} aria-label="查看园区公告">
          <span>园区公告</span>
          <strong>{announcement.title}</strong>
          <em>{announcement.time} · 点击查看</em>
        </button>
      ) : null}
    </div>
  );
}

function SatisfactionDemo({ onBack, onSendToOtto }: {
  onBack: () => void;
  onSendToOtto: () => void;
}): React.JSX.Element {
  const [published, setPublished] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [score, setScore] = useState('5');
  const [focus, setFocus] = useState('网络响应');
  const [feedback, setFeedback] = useState('网络维修响应很快，希望后续公告能提前半天提醒。');
  const [toastOpen, setToastOpen] = useState(false);

  const publish = (): void => {
    setPublished(true);
    setSubmitted(false);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!published) return;
    setSubmitted(true);
    setToastOpen(true);
  };

  return (
    <div className="otto-park-demo">
      <div className="otto-park-demo__topline">
        <button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button>
        <span className={`otto-park-demo__status ${submitted ? 'is-done' : ''}`}>{submitted ? '问卷已提交' : published ? '员工填写中' : '等待园区发布'}</span>
      </div>
      <div className="otto-park-demo__summary">
        <div>
          <div className="otto-park-demo__eyebrow">本地模拟问卷 · 园区发布，员工填写提交</div>
          <h3>2026 年第三季度企业服务满意度调查</h3>
          <p>这条演示包含发布、员工填写、提交回执和园区端汇总状态，后续可接真实问卷系统。</p>
        </div>
        <button type="button" className="otto-park-demo__chat" onClick={onSendToOtto}>改用 Otto 填写</button>
      </div>
      <div className="otto-park-survey">
        <section className="otto-park-survey__publish" aria-label="园区发布问卷">
          <div className="otto-park-receiver__label">园区端</div>
          <h3>发布满意度问卷</h3>
          <p>问卷包含总体评分、重点关注项和改进建议。发布后员工端会出现可填写表单。</p>
          <button type="button" className="otto-park-demo__primary" onClick={publish}>{published ? '重新发布问卷' : '模拟发布问卷'}</button>
        </section>
        <form className={`otto-park-survey__form ${published ? '' : 'is-disabled'}`} onSubmit={submit} aria-label="员工填写满意度调查">
          <div className="otto-park-receiver__label">员工端</div>
          <h3>填写满意度调查</h3>
          <label>
            总体满意度
            <select value={score} onChange={(event) => setScore(event.target.value)} disabled={!published}>
              <option value="5">5 分 · 非常满意</option>
              <option value="4">4 分 · 满意</option>
              <option value="3">3 分 · 一般</option>
              <option value="2">2 分 · 待改进</option>
              <option value="1">1 分 · 不满意</option>
            </select>
          </label>
          <label>
            重点关注
            <input value={focus} onChange={(event) => setFocus(event.target.value)} disabled={!published} />
          </label>
          <label>
            改进建议
            <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={!published} rows={4} />
          </label>
          <button type="submit" className="otto-park-demo__primary" disabled={!published}>提交问卷</button>
        </form>
      </div>
      <div className="otto-park-survey__result" aria-live="polite">
        {submitted ? (
          <>
            <strong>园区端已收到反馈</strong>
            <span>{score} 分 · {focus} · 已进入满意度汇总</span>
          </>
        ) : published ? (
          <span>问卷已发布，等待员工提交。</span>
        ) : (
          <span>园区尚未发布问卷。</span>
        )}
      </div>
      {toastOpen ? (
        <button type="button" className="otto-park-toast otto-park-toast--result" onClick={() => setToastOpen(false)} aria-label="查看满意度提交结果">
          <span>Otto 办公结果</span>
          <strong>满意度问卷已提交</strong>
          <em>{score} 分 · {focus} · 点击收起通知</em>
        </button>
      ) : null}
    </div>
  );
}

function RepairDemo({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [account, setAccount] = useState<EnterpriseAccount | null>(null);
  const [tickets, setTickets] = useState<EnterpriseRepairTicket[]>([]);
  const [view, setView] = useState<'reporter' | 'technician'>('reporter');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<EnterpriseRepairTicket | null>(null);
  const [form, setForm] = useState({ category: '水电', otherCategory: '', location: '某某会议室', issue: '灯坏了', urgency: '普通', contact: '', phone: '' });
  const [response, setResponse] = useState({ type: '远程指导', text: '请先确认墙面开关已打开，再把检查结果填回 Otto。' });
  const initialViewChosen = useRef(false);

  const message = (cause: unknown): string => {
    const value = cause instanceof Error ? cause.message : String(cause);
    return value.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
  };
  const refresh = useCallback(async (): Promise<void> => {
    if (!window.otto?.enterpriseSession || !window.otto?.enterpriseTicketList) {
      setError('当前 Otto 版本不支持服务器报修，请更新后重试。');
      setLoading(false);
      return;
    }
    try {
      const session = await window.otto.enterpriseSession();
      setAccount(session.account);
      if (!session.account) {
        setError('请先登录企业账号并连接企业服务器。');
        setTickets([]);
        return;
      }
      const next = await window.otto.enterpriseTicketList();
      setTickets(next);
      setError(null);
      const pending = next.find((ticket) => ticket.isRecipient && ticket.status !== '已完成');
      if (pending && session.account.tags.includes('维修工作人员')) {
        setSelectedId((current) => current ?? pending.id);
        if (!initialViewChosen.current) setView('technician');
      }
      initialViewChosen.current = true;
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!account) return;
    setForm((current) => ({
      ...current,
      contact: current.contact || account.name,
      phone: current.phone || account.phone?.replace(/^\+86/, '') || '',
    }));
  }, [account]);

  const assignedTickets = tickets.filter((ticket) => ticket.isRecipient);
  const ownTickets = tickets.filter((ticket) => ticket.isCreator);
  const activeTicket = tickets.find((ticket) => ticket.id === selectedId)
    ?? (view === 'technician' ? assignedTickets[0] : ownTickets[0])
    ?? null;
  const isRepairWorker = Boolean(account?.tags.includes('维修工作人员'));

  const replaceTicket = (next: EnterpriseRepairTicket): void => {
    setTickets((current) => [next, ...current.filter((ticket) => ticket.id !== next.id)]);
    setSelectedId(next.id);
  };

  const submitTicket = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const category = form.category === '其他' ? form.otherCategory.trim() || '其他' : form.category;
      const next = await window.otto.enterpriseTicketSubmit({
        title: `${form.location} · ${category}报修`,
        description: form.issue,
        targetTags: ['维修工作人员'],
        category,
        location: form.location,
        urgency: form.urgency,
        contact: form.contact,
        contactPhone: form.phone,
      });
      setReceipt(next);
      replaceTicket(next);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const action = async (
    ticket: EnterpriseRepairTicket,
    value: 'respond' | 'accept' | 'complete' | 'confirm',
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.otto.enterpriseTicketAction(ticket.id, {
        action: value,
        ...(value === 'respond' ? { responseType: response.type, responseText: response.text } : {}),
      });
      replaceTicket(next);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const openAssigned = async (ticket: EnterpriseRepairTicket): Promise<void> => {
    setSelectedId(ticket.id);
    if (!ticket.readAt) {
      try { replaceTicket(await window.otto.enterpriseTicketRead(ticket.id)); } catch { /* poll will retry */ }
    }
  };

  const field = (key: keyof typeof form, label: string, placeholder?: string): React.JSX.Element => (
    <label className="otto-park-form__field">{label}<input required value={form[key]} placeholder={placeholder} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} /></label>
  );

  if (loading) return <div className="otto-park-demo"><div className="otto-park-repair__empty">正在连接企业报修服务器…</div></div>;
  if (!account) return <div className="otto-park-demo"><div className="otto-park-demo__topline"><button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button></div><div className="otto-park-repair__empty">{error || '请先登录企业账号。'}</div></div>;

  return <div className="otto-park-demo">
    <div className="otto-park-demo__topline"><button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button><span className={`otto-park-demo__status ${activeTicket?.status === '已完成' ? 'is-done' : ''}`}>{activeTicket?.status || '服务器已连接'}</span></div>
    <div className="otto-park-demo__summary"><div><div className="otto-park-demo__eyebrow">企业服务器 · {account.organizationName}</div><h3>客户报修 · 申请表与维修回复表</h3><p>当前账号：{account.name}。工单、处理回复和通知状态都会保存到企业服务器。</p></div>{isRepairWorker ? <div className="otto-park-repair__roles" role="group" aria-label="报修工作区"><button type="button" className={view === 'reporter' ? 'is-active' : ''} onClick={() => setView('reporter')}>我要报修</button><button type="button" className={view === 'technician' ? 'is-active' : ''} onClick={() => setView('technician')}>维修工作台（{assignedTickets.filter((ticket) => ticket.status !== '已完成').length}）</button></div> : null}</div>
    {error ? <div className="otto-park-form__receipt" role="alert">{error}</div> : null}
    {view === 'reporter' ? <>
      <form className="otto-park-request-form" onSubmit={(event) => { void submitTicket(event); }} aria-label="客户报修申请表"><div className="otto-park-form__guide"><strong>Otto 填报提示</strong><span>例如“某某会议室的灯坏了”，确认字段后提交。服务器会自动投递给全部维修工作人员。</span></div><div className="otto-park-form__grid">{field('location', '故障位置', '例如：A 座 1203 室会议室')}<label className="otto-park-form__field">报修类别<select aria-label="报修类别" value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}><option>水电</option><option>网络</option><option>空调</option><option>门禁</option><option>其他</option></select></label>{form.category === '其他' ? field('otherCategory', '请填写其他类别', '例如：玻璃门损坏') : null}{field('issue', '故障描述', '例如：灯坏了，不亮')}<label className="otto-park-form__field">紧急程度<select value={form.urgency} onChange={(event) => setForm((current) => ({ ...current, urgency: event.target.value }))}><option>普通</option><option>紧急</option><option>影响办公</option></select></label>{field('contact', '现场联系人')}{field('phone', '联系电话')}</div><button type="submit" className="otto-park-demo__primary" disabled={busy}>{busy ? '正在提交…' : '提交报修申请'}</button>{receipt ? <div className="otto-park-form__receipt">已提交工单 {receipt.id}，已投递 {receipt.recipientCount} 名维修工作人员。{receipt.recipientCount === 0 ? '请联系管理员先指定维修工作人员。' : ''}</div> : null}</form>
      {ownTickets.length ? <div className="otto-park-technician-form"><div className="otto-park-form__guide"><strong>我的报修进度</strong><span>维修人员的处理表会在这里同步，并通过 Otto、短信和飞书提醒。</span></div><div className="otto-park-repair__roles">{ownTickets.slice(0, 6).map((ticket) => <button key={ticket.id} type="button" className={activeTicket?.id === ticket.id ? 'is-active' : ''} onClick={() => setSelectedId(ticket.id)}>{ticket.location || ticket.title} · {ticket.status}</button>)}</div>{activeTicket?.isCreator ? <><div className="otto-park-request-summary"><div><span>工单</span><strong>{activeTicket.id}</strong></div><div><span>状态</span><strong>{activeTicket.status}</strong></div><div><span>维修回复</span><strong>{activeTicket.responseType || '等待处理'}</strong></div><div><span>说明</span><strong>{activeTicket.responseText || '暂无'}</strong></div></div>{activeTicket.status === '待验收' ? <button type="button" className="otto-park-demo__primary" disabled={busy} onClick={() => { void action(activeTicket, 'confirm'); }}>确认企业验收</button> : null}</> : null}</div> : null}
    </> : <div className="otto-park-technician-form"><div className="otto-park-form__guide"><strong>维修人员处理表</strong><span>这里仅显示服务器分配给当前账号的工单。选择工单后接单、回复或提交维修完成。</span></div>{assignedTickets.length ? <><div className="otto-park-repair__roles">{assignedTickets.map((ticket) => <button key={ticket.id} type="button" className={activeTicket?.id === ticket.id ? 'is-active' : ''} onClick={() => { void openAssigned(ticket); }}>{ticket.location || ticket.title} · {ticket.status}{!ticket.readAt ? ' · 新' : ''}</button>)}</div>{activeTicket?.isRecipient ? <><div className="otto-park-request-summary"><div><span>工单</span><strong>{activeTicket.id}</strong></div><div><span>报修人</span><strong>{activeTicket.creator.name}</strong></div><div><span>类别</span><strong>{activeTicket.category || '其他'}</strong></div><div><span>位置</span><strong>{activeTicket.location || '未填写'}</strong></div><div><span>描述</span><strong>{activeTicket.description}</strong></div><div><span>紧急程度</span><strong>{activeTicket.urgency || '普通'}</strong></div></div><form className="otto-park-response-form" onSubmit={(event) => { event.preventDefault(); void action(activeTicket, 'respond'); }} aria-label="维修回复表"><label className="otto-park-form__field">处理方式<select value={response.type} onChange={(event) => setResponse((current) => ({ ...current, type: event.target.value }))}><option>远程指导</option><option>暂时没空</option><option>安排上门</option><option>需要补充信息</option><option>已完成维修</option></select></label><label className="otto-park-form__field">给报修人的说明<textarea required rows={4} value={response.text} onChange={(event) => setResponse((current) => ({ ...current, text: event.target.value }))} /></label><button type="submit" className="otto-park-demo__primary" disabled={busy}>发送维修回复</button></form><div className="otto-park-demo__actions"><button type="button" className="otto-park-demo__secondary" onClick={() => { void action(activeTicket, 'accept'); }} disabled={busy || !['待派单', '待接单'].includes(activeTicket.status)}>接单并处理</button><button type="button" className="otto-park-demo__primary" onClick={() => { void action(activeTicket, 'complete'); }} disabled={busy || activeTicket.status !== '维修中'}>提交维修完成</button></div></> : null}</> : <div className="otto-park-repair__empty">当前没有分配给你的报修工单。</div>}</div>}
  </div>;
}

function ServiceDemo({ service, onBack, onSendToOtto }: {
  service: ParkService;
  onBack: () => void;
  onSendToOtto: () => void;
}): React.JSX.Element {
  const steps = service.steps ?? [];
  const interaction = SERVICE_INTERACTIONS[service.id] ?? { intro: '请先确认申请信息，责任人会在 Otto 内返回办理结果。', quickReplies: ['信息确认', '需要补充材料', '暂时没空，稍后处理'], hint: '提交后通过表单接收办理结果。' };
  const fields = SERVICE_FORM_FIELDS[service.id] ?? [{ label: '申请内容', value: service.demoSubject ?? '' }];
  const [completed, setCompleted] = useState(-1);
  const [requestSubmitted, setRequestSubmitted] = useState(false);
  const [notification, setNotification] = useState<number | null>(null);
  const [notificationLog, setNotificationLog] = useState<Record<number, string>>({});
  const [feishuConnected, setFeishuConnected] = useState(true);
  const [replyDraft, setReplyDraft] = useState('');
  const [resultToast, setResultToast] = useState<string | null>(null);
  const finished = completed >= steps.length - 1;
  const currentNotification = notification === null ? null : steps[notification];

  const submitRequest = (event?: React.FormEvent<HTMLFormElement>): void => {
    event?.preventDefault();
    setRequestSubmitted(true);
    if (steps.length > 1) { setCompleted(0); setNotification(1); } else setCompleted(steps.length - 1);
  };
  const reset = (): void => { setCompleted(-1); setRequestSubmitted(false); setNotification(null); setNotificationLog({}); setReplyDraft(''); setResultToast(null); };
  const acknowledge = useCallback((delivery: string): void => {
    if (notification === null) return;
    const index = notification;
    setNotificationLog((current) => ({ ...current, [index]: delivery }));
    setCompleted(index);
    setNotification(index + 1 < steps.length ? index + 1 : null);
    setReplyDraft('');
    if (index + 1 >= steps.length) setResultToast(`${service.name}已完成办理`);
  }, [notification, service.name, steps.length]);
  useEffect(() => {
    if (notification === null) return;
    const timer = window.setTimeout(() => acknowledge(feishuConnected ? '短信已发送 · 飞书已同步' : '短信已发送'), NOTIFICATION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [acknowledge, notification, feishuConnected]);

  // 特殊服务仍保留各自的业务交互，但与通用服务共享同一套稳定的 Hook 顺序。
  if (service.id === 'announcement') {
    return <AnnouncementDemo onBack={onBack} onSendToOtto={onSendToOtto} />;
  }
  if (service.id === 'satisfaction') {
    return <SatisfactionDemo onBack={onBack} onSendToOtto={onSendToOtto} />;
  }
  if (service.id === 'repair') {
    return <RepairDemo onBack={onBack} />;
  }

  return <div className="otto-park-demo">
    <div className="otto-park-demo__topline"><button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button><span className={`otto-park-demo__status ${finished ? 'is-done' : ''}`}>{finished ? '办理完成' : requestSubmitted ? currentNotification ? '等待责任人回复' : '处理中' : '待填写申请'}</span></div>
    <div className="otto-park-demo__summary"><div><div className="otto-park-demo__eyebrow">本地模拟 · 申请表与处理回复</div><h3>{service.demoSubject}</h3><p>{interaction.intro}</p></div><button type="button" className="otto-park-demo__chat" onClick={onSendToOtto}>改用 Otto 填写</button></div>
    <form className="otto-park-request-form" onSubmit={submitRequest} aria-label={`${service.name}申请表`}><div className="otto-park-form__guide"><strong>填写申请</strong><span>{interaction.hint}</span></div><div className="otto-park-form__grid">{fields.map((field) => <label className="otto-park-form__field" key={field.label}>{field.label}<input defaultValue={field.value} disabled={requestSubmitted} /></label>)}</div><button type="submit" className="otto-park-demo__primary" disabled={requestSubmitted}>{requestSubmitted ? '申请已提交' : `提交${service.name}申请`}</button></form>
    <ol className="otto-park-demo__timeline" aria-label={`${service.name}办理状态`}>{steps.map((step, index) => { const isComplete = index <= completed; const isCurrent = index === notification; return <li key={`${step.role}-${step.owner}-${index}`} className={isComplete ? 'is-complete' : isCurrent ? 'is-current' : ''}><span className="otto-park-demo__marker">{isComplete ? <IconCheck size={13} /> : index + 1}</span><div className="otto-park-demo__step"><div><strong>{step.role}</strong><span>{step.owner}</span></div><p>{step.detail}</p></div><em>{isComplete ? '已完成' : isCurrent ? notificationLog[index] ?? '等待处理' : '未开始'}</em></li>; })}</ol>
    {finished ? <button type="button" className="otto-park-demo__secondary" onClick={reset}>重新填写一份</button> : null}
    {currentNotification ? <div className="otto-park-notice-overlay" role="alertdialog" aria-modal="false" aria-label="Otto 待处理提醒"><div className="otto-park-notice" onClick={(event) => event.stopPropagation()}><div className="otto-park-notice__eyebrow">Otto 待处理提醒 · 本地模拟</div><h3>{currentNotification.role}，请填写处理回复</h3><p className="otto-park-notice__owner">责任人：<strong>{currentNotification.owner}</strong></p><p className="otto-park-notice__detail">{currentNotification.detail}</p><div className="otto-park-notice__channels"><span className="is-active">Otto 弹窗已发送</span><span className={feishuConnected ? 'is-active' : ''}>{feishuConnected ? '飞书已连接' : '飞书未连接'}</span><span>未查看将优先短信</span></div><label className="otto-park-notice__feishu-toggle"><input type="checkbox" checked={feishuConnected} onChange={(event) => setFeishuConnected(event.target.checked)} />模拟飞书已连接</label><div className="otto-park-workflow-form"><label className="otto-park-form__field">处理选项<select value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)}><option value="">请选择处理结果</option>{interaction.quickReplies.map((reply) => <option key={reply}>{reply}</option>)}</select></label><div className="otto-park-notice__actions"><button type="button" className="otto-park-demo__primary" disabled={!replyDraft} onClick={() => acknowledge(replyDraft)}>发送处理回复</button><button type="button" className="otto-park-demo__secondary" onClick={() => acknowledge(feishuConnected ? '未查看 · 短信已发送 · 飞书已同步' : '未查看 · 短信已发送')}>模拟未查看</button></div></div><div className="otto-park-notice__hint">每一环节都通过结构化回复推进，不使用聊天窗口。</div></div></div> : null}
    {resultToast ? <button type="button" className="otto-park-toast otto-park-toast--result" onClick={() => setResultToast(null)} aria-label="查看办理结果"><span>Otto 办理结果</span><strong>{resultToast}</strong><em>点击收起通知</em></button> : null}
  </div>;
}

export function ParkServicesPlugin(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  const [parkName, setParkName] = useState(DEFAULT_PARK);
  const [actors, setActors] = useState<ParkActorDirectory>({});
  const [services, setServices] = useState<ParkService[]>(() => defaultServices(DEFAULT_PARK));
  const [selected, setSelected] = useState<ParkService | null>(null);
  const [backgroundTicket, setBackgroundTicket] = useState<EnterpriseRepairTicket | null>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const notifiedTicketKeys = useRef(new Set<string>());
  const uid = useId();
  const titleId = `${uid}-title`;

  useEffect(() => {
    let cancelled = false;
    void window.otto?.parkConfig?.().then((cfg) => {
      if (cancelled || !cfg) return;
      if (cfg.brandName) setBrand(cfg.brandName);
      if (cfg.services && cfg.services.length > 0) {
        setServices(cfg.services.map((s, i) => ({
          id: `custom-${i}`, icon: ICON_POOL[i % ICON_POOL.length], name: s.name, desc: s.desc, prompt: s.prompt,
        })));
      } else if (cfg.parkName) {
        setParkName(cfg.parkName);
        setServices(defaultServices(cfg.parkName, actors));
      }
    });
    return () => { cancelled = true; };
  }, [actors]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.otto?.enterpriseSession?.().catch(() => null),
      window.otto?.enterpriseOrganizationView?.().catch(() => null),
      window.otto?.enterpriseAccounts?.().catch(() => []),
    ]).then(([session, organizationView, accounts]) => {
      if (cancelled) return;
      const currentUser = session?.account?.name;
      const organizationMembers = organizationView?.members ?? [];
      const accountRows = Array.isArray(accounts) && accounts.length > 0
        ? accounts
        : organizationMembers;
      const nextActors = buildParkActorDirectory(currentUser, accountRows);
      setActors(nextActors);
    });
    return () => { cancelled = true; };
  }, [parkName]);

  useEffect(() => {
    if (open && !selected) firstItemRef.current?.focus();
  }, [open, selected]);

  useEffect(() => {
    const onOpen = (): void => { setSelected(null); setOpen(true); };
    window.addEventListener(PARK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(PARK_OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!window.otto?.enterpriseSession || !window.otto?.enterpriseTicketList) return undefined;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const session = await window.otto.enterpriseSession();
        if (cancelled || !session.account) return;
        const tickets = await window.otto.enterpriseTicketList();
        if (cancelled) return;
        const candidate = tickets.find((ticket) => ticket.isRecipient && !ticket.readAt)
          ?? tickets.find((ticket) => ticket.isCreator && ticket.responseAt)
          ?? tickets.find((ticket) => ticket.isCreator && ticket.status === '待验收');
        if (!candidate) return;
        const key = candidate.isRecipient && !candidate.readAt
          ? `assigned:${candidate.id}`
          : `updated:${candidate.id}:${candidate.updatedAt}`;
        if (notifiedTicketKeys.current.has(key)) return;
        notifiedTicketKeys.current.add(key);
        setBackgroundTicket(candidate);
        const title = candidate.isRecipient && !candidate.readAt
          ? 'Otto 待处理提醒 · 新报修'
          : 'Otto 报修进度提醒';
        const body = candidate.isRecipient && !candidate.readAt
          ? `${candidate.creator.name}：${candidate.location || candidate.title} · ${candidate.description}`
          : `${candidate.location || candidate.title} · ${candidate.responseType || candidate.status}`;
        void window.otto.parkNativeNotify?.(title, body);
      } catch {
        // 未登录、服务器暂不可达时安静重试；报修页打开后会显示具体错误。
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const close = (): void => { setSelected(null); setOpen(false); };
  const pick = (service: ParkService): void => {
    // 企业通过 park-services.json 配置的临时服务没有本地流程定义，保持原有
    // “注入 Otto 输入框”的兼容行为。
    if (!service.steps && !LOCAL_DEMO_SERVICE_IDS.has(service.id)) {
      insertComposerDraft(service.prompt);
      close();
      return;
    }
    setSelected(service);
  };
  const sendToOtto = (): void => {
    if (selected) insertComposerDraft(selected.prompt);
    close();
  };

  const openBackgroundTicket = (): void => {
    const repair = services.find((service) => service.id === 'repair');
    if (repair) {
      setSelected(repair);
      setOpen(true);
    }
    setBackgroundTicket(null);
  };

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
            <h2 className="otto-park-dialog__title" id={titleId}>{selected ? `${selected.name}${selected.id === 'repair' ? ' · 企业服务器' : ' · 本地演示'}` : brand}</h2>
            <div className="otto-park-dialog__subtitle">
              {selected?.id === 'announcement'
                ? '园区端发布消息后，Otto 作为企业接收端在右下角提醒，点击即可查看。'
                : selected?.id === 'satisfaction'
                  ? '园区发布调查问卷，员工填写并提交，形成双向反馈闭环。'
                  : selected?.id === 'repair'
                    ? '报修保存到企业服务器并自动投递维修人员；处理回复通过 Otto、短信和飞书送达。'
                  : selected
                    ? '先提交申请表；责任人通过 Otto 弹窗返回结构化处理结果。'
                    : '9 项服务 · 3 列 × 3 行。选择任一服务即可查看完整本地演示流程。'}
            </div>
          </div>
          <button type="button" className="otto-park-dialog__close" onClick={close} aria-label="关闭"><IconClose size={14} /></button>
        </div>
        {selected ? (
          <ServiceDemo service={selected} onBack={() => setSelected(null)} onSendToOtto={sendToOtto} />
        ) : (
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
        )}
      </div>
    </div>
  ) : null}
  {backgroundTicket ? <button type="button" className="otto-park-toast otto-park-toast--result" onClick={openBackgroundTicket} aria-label="打开报修通知"><span>Otto 企业报修</span><strong>{backgroundTicket.isRecipient && !backgroundTicket.readAt ? '收到新的客户报修申请' : '报修工单已有新进展'}</strong><em>{backgroundTicket.location || backgroundTicket.title} · {backgroundTicket.status} · 点击查看</em></button> : null}
  </>;
}
