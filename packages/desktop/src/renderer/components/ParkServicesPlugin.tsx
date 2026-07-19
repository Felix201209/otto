/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 宏创 AI 园区服务入口。
 *
 * 没有园区服务端时，内置服务会进入「本地演示工单」：每个业务都有预设申请信息、
 * 服务角色和可逐步播放的状态流转。这样演示的业务路径与客户服务流程文档一致，
 * 同时不把任何演示数据伪装成已提交到真实园区系统。
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { insertComposerDraft } from './Composer.js';
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

/** 每项服务的现场沟通方式不同，避免所有业务都变成同一套“下一步”。 */
const SERVICE_INTERACTIONS: Record<string, ServiceInteraction> = {
  renovation: { intro: '装修申请先核对施工范围，再约现场交底；不完整的材料会直接告诉你缺什么。', quickReplies: ['信息已确认，安排现场交底', '需要补充施工方案', '暂时没空，明天下午联系'], hint: '装修通常需要材料确认和现场时间，不建议只用一个“完成”按钮。' },
  parking: { intro: '停车办理先核验车牌和车位，再确认门禁开通时间。', quickReplies: ['车牌信息确认', '请帮我查可用车位', '我晚点补充车辆资料'], hint: '车场管理员可以先查位，企业无需反复电话确认。' },
  'network-phone': { intro: '网络/电话申请先确认安装位置和开通日期；工程师也可以先远程指导自查。', quickReplies: ['需求确认，请安排开通', '请远程指导自查线路', '安排工程师上门'], hint: '能远程排除的问题先在线处理，减少工程师无效上门。' },
  'meeting-room': { intro: '会议室预约会先核对人数、时段和设备；如果冲突，客服会给出替代时段。', quickReplies: ['时间人数确认', '帮我换一个会议室', '需要投屏/视频会议'], hint: '预约不是单向提交，冲突时要能直接换房或补充设备。' },
  'electric-card': { intro: '电卡办理先核验卡号和金额，再提示到客服中心的办理时间。', quickReplies: ['充值信息确认', '请核验电卡余额', '我稍后到客服中心'], hint: '金额和卡号需要二次确认，避免错充。' },
  'vehicle-visit': { intro: '来访车辆先登记人、车牌和时间；安保端会收到放行信息，改期也可直接留言。', quickReplies: ['登记信息确认', '访客改期', '请告知门岗放行规则'], hint: '访客信息有变化时直接回复即可，不必重新打电话。' },
};

/**
 * 9 项正好形成 3 列 × 3 行，对应《客户服务工作流程》。每一条 steps 都是
 * 本地演示数据，真实服务端接入后可替换为工单状态流。
 */
function defaultServices(park: string): ParkService[] {
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

const PARK_OPEN_EVENT = 'otto:open-park-services';
const LOCAL_DEMO_SERVICE_IDS = new Set(['announcement', 'satisfaction']);
const REPAIR_TICKET_STORAGE_KEY = 'otto:local-repair-ticket';
const REPAIR_TICKET_EVENT = 'otto:local-repair-ticket-updated';

interface RepairTicket {
  id: string;
  location: string;
  issue: string;
  urgency: string;
  contact: string;
  status: '待派单' | '待接单' | '维修中' | '待验收' | '已完成';
  createdAt: string;
  lastMessage?: string;
  lastMessageBy?: 'technician' | 'reporter';
}

function readRepairTicket(): RepairTicket | null {
  try {
    const raw = window.localStorage.getItem(REPAIR_TICKET_STORAGE_KEY);
    return raw ? JSON.parse(raw) as RepairTicket : null;
  } catch { return null; }
}

function writeRepairTicket(ticket: RepairTicket): void {
  try { window.localStorage.setItem(REPAIR_TICKET_STORAGE_KEY, JSON.stringify(ticket)); } catch { /* preview may disable storage */ }
  window.dispatchEvent(new CustomEvent(REPAIR_TICKET_EVENT, { detail: ticket }));
}

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

  const publish = (): void => {
    setPublished(true);
    setSubmitted(false);
  };

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!published) return;
    setSubmitted(true);
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
    </div>
  );
}

function RepairDemo({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<'reporter' | 'technician'>('reporter');
  const [ticket, setTicket] = useState<RepairTicket | null>(() => readRepairTicket());
  const [notice, setNotice] = useState(false);
  const [stage, setStage] = useState(0);
  const [draft, setDraft] = useState('');
  const [technicianDraft, setTechnicianDraft] = useState('');
  const lastReplyRef = useRef<string | undefined>(undefined);
  const [messages, setMessages] = useState<Array<{ from: 'otto' | 'user'; text: string }>>([
    { from: 'otto', text: '你好，我是 Otto 报修助手。先告诉我故障发生在哪里？例如“某某会议室”。' },
  ]);
  const questions = [
    '请用一句话描述故障现象，例如“灯坏了”或“网络频繁断开”。',
    '紧急程度如何？可以回复“普通”“紧急”或“影响办公”。',
    '最后请留下现场联系人和手机号，方便维修人员到场联系。',
  ];

  useEffect(() => {
    const onTicket = (event: Event): void => {
      const next = (event as CustomEvent<RepairTicket>).detail ?? readRepairTicket();
      if (next) { setTicket(next); if (mode === 'technician' && next.status === '待派单') setNotice(true); }
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== REPAIR_TICKET_STORAGE_KEY) {
        return;
      }
      const next = readRepairTicket();
      if (next) { setTicket(next); if (mode === 'technician' && next.status === '待派单') setNotice(true); }
    };
    window.addEventListener(REPAIR_TICKET_EVENT, onTicket);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(REPAIR_TICKET_EVENT, onTicket); window.removeEventListener('storage', onStorage); };
  }, [mode]);

  useEffect(() => {
    if (!ticket?.lastMessage || ticket.lastMessageBy !== 'technician' || ticket.lastMessage === lastReplyRef.current) return;
    lastReplyRef.current = ticket.lastMessage;
    setMessages((current) => [...current, { from: 'otto', text: `维修人员张工：${ticket.lastMessage}` }]);
  }, [ticket]);

  const submitAnswer = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const answer = draft.trim();
    if (!answer) return;
    setMessages((current) => [...current, { from: 'user', text: answer }]);
    setDraft('');
    if (stage < 3) {
      setMessages((current) => [...current, { from: 'otto', text: questions[stage] }]);
      setStage((current) => current + 1);
    } else {
      setMessages((current) => [...current, { from: 'otto', text: '信息齐了，我已整理成工单。请确认后提交，网络维修主管会在另一台 Otto 上收到提醒。' }]);
      setStage(4);
    }
  };

  const submitTicket = (): void => {
    const answers = messages.filter((message) => message.from === 'user').map((message) => message.text);
    const next: RepairTicket = {
      id: `DEMO-REPAIR-${Date.now().toString().slice(-6)}`,
      location: answers[0] ?? '某某会议室', issue: answers[1] ?? '照明设备故障',
      urgency: answers[2] ?? '普通', contact: answers[3] ?? '演示报修人', status: '待派单', createdAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    };
    setTicket(next); writeRepairTicket(next);
    setMessages((current) => [...current, { from: 'otto', text: `工单 ${next.id} 已提交，正在自动派单给网络维修主管张工。` }]);
  };

  const updateStatus = (status: RepairTicket['status']): void => {
    if (!ticket) return;
    const next = { ...ticket, status };
    setTicket(next); writeRepairTicket(next); setNotice(false);
  };

  const sendTechnicianReply = (text: string): void => {
    if (!ticket || !text.trim()) return;
    const next = { ...ticket, lastMessage: text.trim(), lastMessageBy: 'technician' as const };
    setTechnicianDraft('');
    setTicket(next);
    writeRepairTicket(next);
    setNotice(false);
  };

  return (
    <div className="otto-park-demo">
      <div className="otto-park-demo__topline">
        <button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button>
        <span className={`otto-park-demo__status ${ticket?.status === '已完成' ? 'is-done' : ''}`}>{ticket ? ticket.status : '待发起'}</span>
      </div>
      <div className="otto-park-demo__summary">
        <div><div className="otto-park-demo__eyebrow">双设备本地演示 · 不使用 Agent</div><h3>客户报修 · Otto 引导填报与维修接单</h3><p>打开两个 Otto 窗口：一台选“报修人端”，另一台选“维修人员端”。</p></div>
        <div className="otto-park-repair__roles" role="group" aria-label="演示设备角色">
          <button type="button" className={mode === 'reporter' ? 'is-active' : ''} onClick={() => setMode('reporter')}>报修人端</button>
          <button type="button" className={mode === 'technician' ? 'is-active' : ''} onClick={() => { setMode('technician'); if (ticket && ticket.status === '待派单') setNotice(true); }}>维修人员端</button>
        </div>
      </div>
      {mode === 'reporter' ? (
        <div className="otto-park-repair__chat" aria-label="Otto 报修引导聊天框">
          <div className="otto-park-repair__chathead"><strong>报修人端</strong><span>Otto 会一步一步帮你填</span></div>
          <div className="otto-park-repair__messages">{messages.map((message, index) => <div key={`${message.from}-${index}`} className={`otto-park-repair__message is-${message.from}`}>{message.text}</div>)}</div>
          {stage < 4 ? <form onSubmit={submitAnswer} className="otto-park-repair__input"><input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={stage === 0 ? '例如：A 座 1203 室会议室' : '输入你的回答…'} aria-label="报修回答" /><button type="submit" className="otto-park-demo__primary">发送</button></form> : <div className="otto-park-repair__confirm"><div><strong>工单信息已整理</strong><span>位置、故障、紧急程度和联系人均已填写</span></div><button type="button" className="otto-park-demo__primary" onClick={submitTicket} disabled={ticket?.status === '待派单'}>{ticket?.status === '待派单' ? '已提交，等待维修人员' : '提交报修工单'}</button></div>}
        </div>
      ) : (
        <div className="otto-park-repair__technician">
          <div className="otto-park-repair__chathead"><strong>维修人员端 · 网络维修主管张工</strong><span>这台 Otto 只接收待处理提醒</span></div>
          {!ticket ? <div className="otto-park-repair__empty">等待报修人提交工单。提交后，本窗口会弹出 Otto 待处理提醒。</div> : <><div className="otto-park-repair__ticket"><div><span>工单号</span><strong>{ticket.id}</strong></div><div><span>故障位置</span><strong>{ticket.location}</strong></div><div><span>故障描述</span><strong>{ticket.issue}</strong></div><div><span>紧急程度</span><strong>{ticket.urgency}</strong></div><div><span>现场联系人</span><strong>{ticket.contact}</strong></div></div><div className="otto-park-repair__reply"><div className="otto-park-repair__replytitle"><strong>给报修人回消息</strong><span>能远程解决就不用来回打电话</span></div><div className="otto-park-repair__quick"><button type="button" onClick={() => sendTechnicianReply('我正在处理另一条工单，预计 30 分钟后回复。请先在 Otto 留言，不用打电话。')}>暂时没空</button><button type="button" onClick={() => sendTechnicianReply('可以先自助排查：请确认会议室墙面开关已打开，再拍一张灯具和开关的照片发回 Otto。')}>发自助排查指引</button><button type="button" onClick={() => sendTechnicianReply('我可以在今天 15:30–16:00 上门，请回复“可以”或告诉我合适时段。')}>安排上门时间</button></div><form className="otto-park-repair__input" onSubmit={(event) => { event.preventDefault(); sendTechnicianReply(technicianDraft); }}><input value={technicianDraft} onChange={(event) => setTechnicianDraft(event.target.value)} placeholder="输入给报修人的回复…" aria-label="回复报修人员" /><button type="submit" className="otto-park-demo__primary">发送回复</button></form></div><div className="otto-park-demo__actions"><button type="button" className="otto-park-demo__primary" onClick={() => updateStatus('维修中')} disabled={ticket.status !== '待派单' && ticket.status !== '待接单'}>接单并开始维修</button><button type="button" className="otto-park-demo__secondary" onClick={() => updateStatus('待验收')} disabled={ticket.status !== '维修中'}>维修完成，等待验收</button>{ticket.status === '待验收' ? <button type="button" className="otto-park-demo__primary" onClick={() => updateStatus('已完成')}>确认企业验收</button> : null}</div></>}
        </div>
      )}
      {notice && ticket ? <div className="otto-park-notice-overlay" role="alertdialog" aria-modal="true" aria-label="Otto 待处理提醒"><div className="otto-park-notice"><div className="otto-park-notice__eyebrow">Otto 待处理提醒 · 本地模拟</div><h3>企业用户，请处理这条服务环节</h3><p className="otto-park-notice__owner">责任人：<strong>网络维修主管张工</strong></p><p className="otto-park-notice__detail">{ticket.location} · {ticket.issue} · {ticket.urgency}</p><div className="otto-park-notice__channels"><span className="is-active">Otto 弹窗已发送</span><span>未查看优先短信</span></div><div className="otto-park-repair__reply otto-park-notice__reply"><div className="otto-park-repair__replytitle"><strong>现在可以怎么处理？</strong><span>选择一个回复，报修人端会马上收到</span></div><div className="otto-park-repair__quick"><button type="button" onClick={() => sendTechnicianReply('我暂时没空，预计 30 分钟后回复，请先在 Otto 留言。')}>暂时没空</button><button type="button" onClick={() => sendTechnicianReply('请先按 Otto 指引检查开关，并拍照发回，我可以远程判断。')}>远程指导自查</button><button type="button" onClick={() => sendTechnicianReply('我可以安排上门，请回复合适的时间段。')}>预约上门</button></div><form className="otto-park-repair__input" onSubmit={(event) => { event.preventDefault(); sendTechnicianReply(technicianDraft); }}><input value={technicianDraft} onChange={(event) => setTechnicianDraft(event.target.value)} placeholder="输入回复…" aria-label="弹窗回复报修人员" /><button type="submit" className="otto-park-demo__primary">发送</button></form></div><div className="otto-park-notice__actions"><button type="button" className="otto-park-demo__primary" onClick={() => { setNotice(false); updateStatus('维修中'); }}>已查看并接单</button><button type="button" className="otto-park-demo__secondary" onClick={() => setNotice(false)}>稍后处理</button></div></div></div> : null}
    </div>
  );
}

function ServiceDemo({ service, onBack, onSendToOtto }: {
  service: ParkService;
  onBack: () => void;
  onSendToOtto: () => void;
}): React.JSX.Element {
  if (service.id === 'announcement') {
    return <AnnouncementDemo onBack={onBack} onSendToOtto={onSendToOtto} />;
  }
  if (service.id === 'satisfaction') {
    return <SatisfactionDemo onBack={onBack} onSendToOtto={onSendToOtto} />;
  }
  if (service.id === 'repair') {
    return <RepairDemo onBack={onBack} />;
  }

  const steps = service.steps ?? [];
  const [completed, setCompleted] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [notification, setNotification] = useState<number | null>(null);
  const [notificationLog, setNotificationLog] = useState<Record<number, string>>({});
  const [feishuConnected, setFeishuConnected] = useState(true);
  const [conversation, setConversation] = useState<Array<{ from: 'otto' | 'staff' | 'user'; text: string }>>([
    { from: 'otto', text: SERVICE_INTERACTIONS[service.id]?.intro ?? 'Otto 会根据这个服务的办理规则，提示下一步需要确认的信息。' },
  ]);
  const [replyDraft, setReplyDraft] = useState('');
  const interaction = SERVICE_INTERACTIONS[service.id] ?? {
    intro: 'Otto 会根据当前责任人的处理进度，提示你确认、补充或改期。',
    quickReplies: ['已收到，请继续', '需要补充信息', '暂时没空，稍后联系'],
    hint: '可以直接在 Otto 里回复，不需要额外打电话。',
  };
  const finished = completed >= steps.length - 1;

  // 每进入一个新环节，先暂停流转并提醒对应责任人，模拟 Otto 中台派单。
  useEffect(() => {
    const next = completed + 1;
    if (next < 0 || next >= steps.length || notificationLog[next]) return;
    setPlaying(false);
    setNotification(next);
  }, [completed, notificationLog, steps.length]);

  useEffect(() => {
    if (!playing) return;
    if (completed >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setCompleted((current) => current + 1), 680);
    return () => window.clearTimeout(timer);
  }, [completed, playing, steps.length]);

  const startOrContinue = (): void => {
    if (finished) {
      setCompleted(-1);
      setNotification(null);
      setNotificationLog({});
      setPlaying(true);
      return;
    }
    setPlaying(true);
  };

  const next = (): void => {
    setPlaying(false);
    setCompleted((current) => Math.min(current + 1, steps.length - 1));
  };

  const acknowledge = (delivery: string): void => {
    if (notification === null) return;
    setConversation((current) => [...current, { from: 'staff', text: `已收到你的回复：“${delivery}”。我会把它同步到当前服务环节。` }]);
    setNotificationLog((current) => ({ ...current, [notification]: delivery }));
    setNotification(null);
  };

  const sendReply = (text: string): void => {
    const value = text.trim();
    if (!value) return;
    setConversation((current) => [...current, { from: 'user', text: value }]);
    setReplyDraft('');
  };

  const currentNotification = notification === null ? null : steps[notification];

  // 本地演示也保留真实接入后的兜底语义：责任人 12 秒没有查看 Otto，
  // 自动记录短信已发送；飞书已连接时同时记录飞书同步。
  useEffect(() => {
    if (notification === null) return;
    const timer = window.setTimeout(() => {
      setNotificationLog((current) => ({
        ...current,
        [notification]: feishuConnected ? '短信已发送 · 飞书已同步' : '短信已发送',
      }));
      setNotification(null);
    }, NOTIFICATION_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [feishuConnected, notification]);

  return (
    <div className="otto-park-demo">
      <div className="otto-park-demo__topline">
        <button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button>
        <span className={`otto-park-demo__status ${finished ? 'is-done' : ''}`}>
          {finished ? '已完成本地演示' : currentNotification ? '等待责任人处理' : completed < 0 ? '待发起' : playing ? '模拟流转中' : '等待下一步'}
        </span>
      </div>
      <div className="otto-park-demo__summary">
        <div>
          <div className="otto-park-demo__eyebrow">本地模拟工单 · 不会提交到真实园区系统</div>
          <h3>{service.demoSubject}</h3>
          <p>服务：{service.name}　·　演示编号：DEMO-{service.id.toUpperCase()}-001</p>
        </div>
        <button type="button" className="otto-park-demo__chat" onClick={onSendToOtto}>改用 Otto 填写</button>
      </div>
      <ol className="otto-park-demo__timeline" aria-label={`${service.name}办理流程`}>
        {steps.map((step, index) => {
          const isComplete = index <= completed;
          const isCurrent = index === completed + 1 && !finished;
          return (
            <li key={`${step.role}-${step.owner}-${index}`} className={isComplete ? 'is-complete' : isCurrent ? 'is-current' : ''}>
              <span className="otto-park-demo__marker">{isComplete ? <IconCheck size={13} /> : index + 1}</span>
              <div className="otto-park-demo__step">
                <div><strong>{step.role}</strong><span>{step.owner}</span></div>
                <p>{step.detail}</p>
              </div>
              <em>{isComplete ? '已完成' : isCurrent ? notificationLog[index] ?? '待处理提醒' : '待处理'}</em>
            </li>
          );
        })}
      </ol>
      <div className="otto-park-workflow-chat" aria-label={`${service.name}沟通区`}>
        <div className="otto-park-repair__chathead"><strong>Otto 协作沟通</strong><span>{interaction.hint}</span></div>
        <div className="otto-park-repair__messages">{conversation.map((message, index) => <div key={`${message.from}-${index}`} className={`otto-park-repair__message is-${message.from === 'user' ? 'user' : 'otto'}`}>{message.text}</div>)}</div>
        <div className="otto-park-workflow-chat__quick">{interaction.quickReplies.map((reply) => <button key={reply} type="button" onClick={() => { sendReply(reply); if (notification !== null) acknowledge(reply); }}>{reply}</button>)}</div>
        <form className="otto-park-repair__input" onSubmit={(event) => { event.preventDefault(); sendReply(replyDraft); }}><input value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)} placeholder="输入给客服/专员的回复…" aria-label="园区服务回复" /><button type="submit" className="otto-park-demo__primary">发送</button></form>
      </div>
      <div className="otto-park-demo__actions">
        <button type="button" className="otto-park-demo__primary" onClick={startOrContinue}>
          {finished ? '重新演示' : playing ? '正在自动流转…' : completed < 0 ? '开始演示流程' : '继续自动流转'}
        </button>
        {!finished ? <button type="button" className="otto-park-demo__secondary" onClick={next}>下一步</button> : null}
      </div>
      {currentNotification ? (
        <div className="otto-park-notice-overlay" role="alertdialog" aria-modal="true" aria-label="Otto 待处理提醒">
          <div className="otto-park-notice" onClick={(event) => event.stopPropagation()}>
            <div className="otto-park-notice__eyebrow">Otto 待处理提醒 · 本地模拟</div>
            <h3>{currentNotification.role}，请处理这条服务环节</h3>
            <p className="otto-park-notice__owner">责任人：<strong>{currentNotification.owner}</strong></p>
            <p className="otto-park-notice__detail">{currentNotification.detail}</p>
            <div className="otto-park-notice__channels" aria-label="通知渠道">
              <span className="is-active">Otto 弹窗已发送</span>
              <span className={feishuConnected ? 'is-active' : ''}>{feishuConnected ? '飞书已连接' : '飞书未连接'}</span>
              <span>未查看将优先短信</span>
            </div>
            <label className="otto-park-notice__feishu-toggle">
              <input type="checkbox" checked={feishuConnected} onChange={(event) => setFeishuConnected(event.target.checked)} />
              模拟飞书已连接（未查看时自动同步）
            </label>
            <div className="otto-park-notice__actions">
              <div className="otto-park-workflow-chat__quick">{interaction.quickReplies.slice(0, 2).map((reply) => <button key={reply} type="button" onClick={() => acknowledge(reply)}>{reply}</button>)}</div>
              <button type="button" className="otto-park-demo__primary" onClick={() => acknowledge('已查看并接单')}>已查看并接单</button>
              <button type="button" className="otto-park-demo__secondary" onClick={() => acknowledge(feishuConnected ? '短信已发送 · 飞书已同步' : '短信已发送')}>模拟未查看，先发短信</button>
            </div>
            <div className="otto-park-notice__hint">12 秒未查看会自动短信提醒；演示中也可直接点击“模拟未查看”查看短信优先、飞书同步的兜底路径。</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ParkServicesPlugin(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  const [services, setServices] = useState<ParkService[]>(() => defaultServices(DEFAULT_PARK));
  const [selected, setSelected] = useState<ParkService | null>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
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
        setServices(defaultServices(cfg.parkName));
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (open && !selected) firstItemRef.current?.focus();
  }, [open, selected]);

  useEffect(() => {
    const onOpen = (): void => { setSelected(null); setOpen(true); };
    window.addEventListener(PARK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(PARK_OPEN_EVENT, onOpen);
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

  return open ? (
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
            <h2 className="otto-park-dialog__title" id={titleId}>{selected ? `${selected.name} · 本地演示` : brand}</h2>
            <div className="otto-park-dialog__subtitle">
              {selected?.id === 'announcement'
                ? '园区端发布消息后，Otto 作为企业接收端在右下角提醒，点击即可查看。'
                : selected?.id === 'satisfaction'
                  ? '园区发布调查问卷，员工填写并提交，形成双向反馈闭环。'
                  : selected?.id === 'repair'
                    ? '报修人端由 Otto 固定问答引导填报；维修人员端接收待处理提醒并推进工单。'
                  : selected
                    ? '每一步都会提醒对应责任人；可模拟 Otto、短信与飞书的接力。'
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
  ) : <></>;
}
