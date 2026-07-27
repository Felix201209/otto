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

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { insertComposerDraft } from './Composer.js';
import type {
  EnterpriseAccount,
  EnterpriseParkPublication,
  EnterpriseParkResources,
  EnterpriseParkStatistics,
  EnterpriseRepairTicket,
  EnterpriseRepairTicketHistoryEntry,
  EnterpriseOrganizationView,
} from '../../preload/index.js';
import defaultMeetingRoomImage from '../assets/meeting-room-default.png';
import {
  IconBuilding,
  IconCalendarCheck,
  IconChevronDown,
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
const ACTIONABLE_STAFF_TICKET_STATUSES = new Set(['待派单', '待接单', '维修中', '处理中', '已转交']);
const STAFF_HISTORY_TICKET_STATUSES = new Set(['待验收', '已完成']);

export function isActionableStaffTicket(ticket: EnterpriseRepairTicket): boolean {
  return Boolean(
    ticket.isRecipient
    && ticket.deliveryStatus !== 'transferred'
    && ACTIONABLE_STAFF_TICKET_STATUSES.has(ticket.status),
  );
}

export function isStaffHistoryTicket(ticket: EnterpriseRepairTicket): boolean {
  return Boolean(
    ticket.isRecipient
    && (ticket.deliveryStatus === 'transferred' || STAFF_HISTORY_TICKET_STATUSES.has(ticket.status)),
  );
}

const HISTORY_ACTION_LABELS: Record<EnterpriseRepairTicketHistoryEntry['action'], string> = {
  created: '提交服务申请',
  accept: '接单并开始处理',
  respond: '填写办理回复',
  transfer: '转交工作人员',
  complete: '完成工作',
  confirm: '申请人确认验收',
};

function parkTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatParkTimestamp(value: string): string {
  const timestamp = parkTimestamp(value);
  if (!timestamp) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(timestamp);
}

function ticketLatestTimestamp(ticket: EnterpriseRepairTicket): number {
  const history = ticket.history ?? [];
  return parkTimestamp(history[history.length - 1]?.createdAt || ticket.responseAt || ticket.updatedAt || ticket.createdAt);
}

function assignedNotificationKey(ticket: EnterpriseRepairTicket): string {
  return `assigned:${ticket.id}`;
}

function creatorUpdateNotificationKey(ticket: EnterpriseRepairTicket): string {
  return `updated:${ticket.id}:${ticket.updatedAt}`;
}

function showParkNotification(
  payload: Parameters<NonNullable<typeof window.otto.notificationShow>>[0],
  fallbackTitle: string,
  fallbackBody: string,
): void {
  const notify = window.otto.notificationShow?.(payload);
  if (notify) {
    void notify.catch(() => {
      void window.otto.parkNativeNotify?.(fallbackTitle, fallbackBody);
    });
  } else {
    void window.otto.parkNativeNotify?.(fallbackTitle, fallbackBody);
  }
}

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
  parking: { intro: '选择停车位办理内容和数量，园区客服会核对费用并回复办理安排。', quickReplies: ['申请信息已确认', '请到客服中心办理', '需要补充企业资料'], hint: '价格来自园区停车位受理单，提交前可直接核对申请内容与数量。' },
  'network-phone': { intro: '选择网络或固话业务、数量和期望开通日期，费用会按受理单自动统计。', quickReplies: ['需求确认，请安排开通', '需要补充开户资料', '已安排工程人员'], hint: '所有业务类型和价格均来自园区网络、电话业务受理单。' },
  'meeting-room': { intro: '会议室预约会先核对人数、时段和设备；如果冲突，客服会给出替代时段。', quickReplies: ['时间人数确认', '帮我换一个会议室', '需要投屏/视频会议'], hint: '预约不是单向提交，冲突时要能直接换房或补充设备。' },
  'electric-card': { intro: '填写充值金额即可提交电卡服务申请，客服会回复办理结果。', quickReplies: ['充值信息已确认', '请到客服中心办理', '充值已完成'], hint: '无需填写电卡编号，园区按企业与房间信息核对。' },
  repair: { intro: '选择或输入报修类别并描述故障，客服可直接回复或转交工作人员。', quickReplies: ['远程指导', '已安排上门', '需要补充信息'], hint: '提交后可在“我的办理进度”中查看客服回复、转交和最终完成状态。' },
  'vehicle-visit': { intro: '填写来访日期、拜访事由和车辆数量，系统会按数量生成车牌输入框。', quickReplies: ['登记信息已确认', '访客信息需补充', '门岗已收到放行信息'], hint: '无车辆可填写 0；有多辆车时逐辆登记车牌。' },
};

interface ServiceFormField {
  key: string;
  label: string;
  placeholder: string;
  options?: Array<string | { value: string; label: string }>;
  inputType?: 'text' | 'date' | 'number' | 'textarea';
  min?: number;
  max?: number;
  allowCustom?: boolean;
}

const COMMON_SERVICE_FORM_FIELDS: ServiceFormField[] = [
  { key: 'company', label: '公司名称', placeholder: '请输入公司名称' },
  { key: 'roomNumber', label: '房间号', placeholder: '请输入门牌或房间号' },
  { key: 'contact', label: '联系人', placeholder: '请输入联系人姓名' },
  { key: 'phone', label: '联系电话', placeholder: '请输入联系电话' },
];
const COMMON_SERVICE_FORM_KEYS = new Set(COMMON_SERVICE_FORM_FIELDS.map((field) => field.key));

const SERVICE_FORM_FIELDS: Record<string, ServiceFormField[]> = {
  renovation: [
    { key: 'area', label: '装修区域', placeholder: '例如：A 座 1203 室' },
    { key: 'startDate', label: '计划开工日期', placeholder: '请选择计划开工日期', inputType: 'date' },
  ],
  parking: [
    { key: 'applicationType', label: '申请内容', placeholder: '请选择停车办理内容', options: [
      { value: 'underground-fixed', label: '地下固定停车位 · 260 元/月' },
      { value: 'underground-tandem', label: '地下固定子母停车位 · 390 元/月' },
      { value: 'surface-temporary', label: '地上临时停车位 · 1200 元/半年' },
      { value: 'underground-temporary', label: '地下临时停车位 · 1560 元/半年' },
      { value: 'cancel', label: '退停车位' },
    ] },
    { key: 'quantity', label: '申请数量', placeholder: '请输入申请数量', inputType: 'number', min: 1 },
  ],
  'network-phone': [
    { key: 'businessType', label: '业务类型', placeholder: '请选择业务类型', options: [
      { value: 'phone-open', label: '开通电话 · 235 元/部，另收 35 元/月/部' },
      { value: 'caller-id', label: '来电显示 · 50 元/部，另收 5 元/月/部' },
      { value: 'number-hold', label: '停机保号 · 5 元/月/部' },
      { value: 'landline-stop', label: '固话停机' },
      { value: 'leased-line-15', label: '企业专线 15M · 500 元/月' },
      { value: 'leased-line-30', label: '企业专线 30M · 1000 元/月' },
      { value: 'leased-line-45', label: '企业专线 45M · 1600 元/月' },
      { value: 'leased-line-75', label: '企业专线 75M · 2900 元/月' },
    ] },
    { key: 'quantity', label: '工位或号码数量', placeholder: '请输入数量', inputType: 'number', min: 1 },
    { key: 'expectedDate', label: '期望开通日期', placeholder: '请选择期望开通日期', inputType: 'date' },
  ],
  'meeting-room': [
    { key: 'attendees', label: '参会人数', placeholder: '请输入人数', inputType: 'number', min: 1 },
    { key: 'meetingContent', label: '会议内容', placeholder: '请简要填写会议主题或内容', inputType: 'textarea' },
  ],
  'electric-card': [
    { key: 'amount', label: '充值金额', placeholder: '请输入充值金额（元）', inputType: 'number', min: 1 },
  ],
  repair: [
    { key: 'category', label: '报修类别', placeholder: '选择或输入报修类别', allowCustom: true, options: [
      '灯具维修', '配电维修', '暖通维修', '网络、电话故障维修', '园区车辆车牌变更',
    ] },
    { key: 'issue', label: '故障描述', placeholder: '请说明发生了什么问题', inputType: 'textarea' },
    { key: 'urgency', label: '紧急程度', placeholder: '请选择紧急程度', options: ['普通', '紧急', '影响办公'] },
  ],
  'vehicle-visit': [
    { key: 'visitDate', label: '来访日期', placeholder: '请选择来访日期', inputType: 'date' },
    { key: 'reason', label: '拜访企业及事由', placeholder: '请填写拜访对象和事由', inputType: 'textarea' },
    { key: 'vehicleCount', label: '来访车辆数量', placeholder: '无车辆可填写 0', inputType: 'number', min: 0, max: 20 },
  ],
};

export function serviceFormFields(serviceId: string): ServiceFormField[] {
  const specific = SERVICE_FORM_FIELDS[serviceId] ?? [];
  return [...COMMON_SERVICE_FORM_FIELDS, ...specific.filter((field) => !COMMON_SERVICE_FORM_KEYS.has(field.key))];
}

function ticketFieldLabel(serviceId: string, key: string): string {
  if (key === 'roomName') return '会议室';
  if (key === 'slotKey') return '预约时段代码';
  if (key === 'roomCapacity') return '会议室容量';
  if (key === 'priceHalfDay') return '半日费用';
  if (key === 'startTime') return '开始时间';
  if (key === 'endTime') return '结束时间';
  if (key === 'amountCny') return '本次金额';
  if (key === 'recurringMonthlyCny') return '每月持续费用';
  if (key === 'pricing') return '计费说明';
  if (key === 'billingUnit') return '计费周期';
  if (/^plate\d+$/.test(key)) return `第 ${key.slice(5)} 辆车车牌号`;
  return serviceFormFields(serviceId).find((field) => field.key === key)?.label || key;
}

function visibleTicketFormEntries(ticket: EnterpriseRepairTicket): Array<[string, string]> {
  const common = ['company', 'roomNumber', 'contact', 'phone'];
  const fieldsByService: Record<string, string[]> = {
    renovation: [...common, 'area', 'startDate'],
    parking: [...common, 'applicationType', 'quantity', 'pricing', 'amountCny'],
    'network-phone': [
      ...common, 'businessType', 'quantity', 'expectedDate', 'amountCny', 'recurringMonthlyCny',
    ],
    'meeting-room': [
      ...common, 'roomName', 'date', 'time', 'attendees', 'meetingContent', 'pricing', 'amountCny',
    ],
    'electric-card': [...common, 'amount'],
    repair: [...common, 'category', 'issue', 'urgency'],
    'vehicle-visit': [...common, 'visitDate', 'reason', 'vehicleCount'],
  };
  const keys = fieldsByService[ticket.serviceId] ?? Object.keys(ticket.formData);
  if (ticket.serviceId === 'vehicle-visit') {
    keys.push(...Object.keys(ticket.formData).filter((key) => /^plate\d+$/.test(key)).sort((left, right) => (
      Number(left.slice(5)) - Number(right.slice(5))
    )));
  }
  return keys.flatMap((key) => {
    const value = ticket.formData[key];
    return typeof value === 'string' && value.trim() ? [[key, value] as [string, string]] : [];
  });
}

function visibleTicketHistory(ticket: EnterpriseRepairTicket): EnterpriseRepairTicketHistoryEntry[] {
  if (ticket.history?.length) return ticket.history;
  const history: EnterpriseRepairTicketHistoryEntry[] = [{
    id: `fallback_created_${ticket.id}`,
    action: 'created',
    statusBefore: null,
    statusAfter: '待接单',
    responseType: null,
    responseText: null,
    createdAt: ticket.createdAt,
    actor: { id: ticket.creator.id, name: ticket.creator.name },
  }];
  if (ticket.responseAt) {
    history.push({
      id: `fallback_response_${ticket.id}`,
      action: 'respond',
      statusBefore: null,
      statusAfter: ticket.status,
      responseType: ticket.responseType,
      responseText: ticket.responseText,
      createdAt: ticket.responseAt,
      actor: null,
    });
  }
  return history;
}

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
      id: 'parking', icon: IconIdBadge, name: '停车办理', desc: '停车位申请、续办与退办',
      prompt: `帮我提交${park}停车办理申请。公司名称：；房间号：；申请内容：；申请数量：；联系人：；联系电话：`,
      demoSubject: '地下固定停车位办理申请',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上选择停车办理内容、数量并提交联系人信息。' },
        { role: '专属客服', owner: '林晓', detail: '即时受理并联系企业确认停车位需求。' },
        { role: '车场管理员', owner: '李队', detail: '核验申请内容与停车位办理规则。' },
        { role: '企业与客服', owner: '线下办理', detail: '签署停车位开通手续，登记授权车辆。' },
        { role: '车场管理员', owner: '李队', detail: '完成门禁权限开通并通知企业验收。' },
      ],
    },
    {
      id: 'network-phone', icon: IconWrench, name: '网络与电话', desc: '宽带、固话开通与调试',
      prompt: `帮我提交${park}网络或固话业务申请。公司名称：；房间号：；业务类型：；工位或号码数量：；期望开通日期：；联系人：；联系电话：`,
      demoSubject: 'A 座 1203 室企业网络开通申请',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上提交网络或电话业务、数量和期望开通日期。' },
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
      id: 'electric-card', icon: IconPackage, name: '电卡服务', desc: '提交电卡充值金额',
      prompt: `帮我提交${park}电卡服务申请。公司名称：；房间号：；充值金额：；联系人：；联系电话：`,
      demoSubject: '电卡充值申请 · 500 元',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上提交充值金额、企业房间和联系人。' },
        { role: '专属客服', owner: '林晓', detail: '即时受理并联系企业确认充值信息。' },
        { role: '能源服务专员', owner: '王敏', detail: '核验电卡状态，预约线下办理时间。' },
        { role: '企业用户', owner: '线下办理', detail: '携带电卡至客服中心完成充值手续。' },
        { role: '能源服务专员', owner: '王敏', detail: '写入余额、出具充值结果，流程办结。' },
      ],
    },
    {
      id: 'repair', icon: IconWrench, name: '物业报修', desc: '客服回复、转交与上门维修',
      prompt: `帮我提交${park}物业报修工单。公司名称：；房间号：；报修类别：；故障描述：；紧急程度：；联系人：；联系电话：`,
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
      id: 'vehicle-visit', icon: IconIdBadge, name: '车辆与访客', desc: '访客日期与车辆预约登记',
      prompt: `帮我登记${park}车辆与访客申请。公司名称：；房间号：；来访日期：；拜访企业及事由：；车辆数量：；各车辆车牌号：；联系人：；联系电话：`,
      demoSubject: '车辆与访客预约登记',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上提供日期、拜访事由和按车辆数量生成的车牌信息。' },
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
  const [brand, setBrand] = useState('');
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const enterpriseParkView = window.otto?.enterpriseParkView;
      if (typeof enterpriseParkView === 'function') {
        try {
          const park = await enterpriseParkView();
          if (!cancelled) {
            setBrand(park?.status === 'active' ? park.brandName?.trim() || DEFAULT_BRAND : '');
          }
        } catch {
          if (!cancelled) setBrand('');
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
  const selected = items.find((item) => item.id === selectedId) ?? null;
  return <div className="otto-park-demo">
    <div className="otto-park-demo__topline"><button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button><span className="otto-park-demo__status">{items.filter((item) => !item.readAt).length} 条未读</span></div>
    <div className="otto-park-demo__summary"><div><div className="otto-park-demo__eyebrow">园区通知</div><h3>园区公告</h3><p>查看园区发布的停水停电、活动和服务通知。</p></div></div>
    {error ? <div className="otto-park-form__receipt" role="alert">{error}</div> : null}
    {loading ? <div className="otto-park-repair__empty">正在读取公告…</div> : items.length ? <div className="otto-park-survey"><section className="otto-park-survey__publish" aria-label="公告列表"><div className="otto-park-repair__roles">{items.map((item) => <button key={item.id} type="button" className={selected?.id === item.id ? 'is-active' : ''} onClick={() => { void openItem(item); }}>{item.readAt ? '' : '新 · '}{item.title}</button>)}</div></section>{selected ? <section className="otto-park-announcement-detail" aria-label="公告详情"><div className="otto-park-receiver__label">已查看</div><h3>{selected.title}</h3><p>{selected.body}</p><small>{new Date(selected.createdAt).toLocaleString('zh-CN')}</small></section> : <div className="otto-park-repair__empty">选择一条公告查看内容，打开后会自动确认已查看。</div>}</div> : <div className="otto-park-repair__empty">暂无园区公告。</div>}
  </div>;
}

function SatisfactionView({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [items, setItems] = useState<EnterpriseParkPublication[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [account, setAccount] = useState<EnterpriseAccount | null>(null);
  const [score, setScore] = useState('5');
  const [focus, setFocus] = useState('');
  const [feedback, setFeedback] = useState('');
  const [identity, setIdentity] = useState({
    company: '', address: '', roomNumber: '', contact: '', phone: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [session, publications, park] = await Promise.all([
        window.otto.enterpriseSession(),
        window.otto.enterpriseParkPublications(),
        typeof window.otto.enterpriseParkView === 'function'
          ? window.otto.enterpriseParkView().catch(() => null)
          : Promise.resolve(null),
      ]);
      setAccount(session.account);
      setIdentity({
        company: session.account?.organizationName || '',
        address: park?.tenantAddress || '',
        roomNumber: park?.tenantRoomNumber || '',
        contact: session.account?.name || '',
        phone: session.account?.phone?.replace(/^\+86/, '') || '',
      });
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
      const requiredIdentity = Object.fromEntries(
        Object.entries(identity).map(([key, value]) => [key, value.trim()]),
      );
      if (Object.values(requiredIdentity).some((value) => !value))
        throw new Error('请完善公司、地址、房间和联系人信息');
      const next = await window.otto.enterpriseParkSurveySubmit(selected.id, {
        ...requiredIdentity, score, focus, feedback, submittedBy: identity.contact || account?.name || '',
      });
      setItems((current) => current.map((item) => item.id === next.id ? next : item));
      window.dispatchEvent(new CustomEvent('otto:park-publication-handled', { detail: { id: selected.id } }));
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  return <div className="otto-park-demo">
    <div className="otto-park-demo__topline"><button type="button" className="otto-park-demo__back" onClick={onBack}>← 返回服务列表</button><span className={`otto-park-demo__status ${selected?.submittedAt ? 'is-done' : ''}`}>{selected?.submittedAt ? '已提交' : selected ? '待填写' : '暂无问卷'}</span></div>
    <div className="otto-park-demo__summary"><div><div className="otto-park-demo__eyebrow">实名反馈</div><h3>满意度调查</h3><p>每份问卷只能提交一次，提交后不能修改。</p></div></div>
    {error ? <div className="otto-park-form__receipt" role="alert">{error}</div> : null}
    {items.length ? <><div className="otto-park-repair__roles">{items.map((item) => <button key={item.id} type="button" className={selected?.id === item.id ? 'is-active' : ''} onClick={() => setSelectedId(item.id)}>{item.submittedAt ? '已提交 · ' : '待填写 · '}{item.title}</button>)}</div>{selected ? <form className="otto-park-survey__form" onSubmit={(event) => { void submit(event); }} aria-label="员工填写满意度调查"><div className="otto-park-receiver__label">提交人：{account?.name || '当前用户'}</div><h3>{selected.title}</h3><p>{selected.body}</p><div className="otto-park-form__grid">{COMMON_SERVICE_FORM_FIELDS.map((field) => <label key={field.key} className="otto-park-form__field">{field.label}<input aria-label={field.label} required value={selected.responseData?.[field.key] ?? identity[field.key as keyof typeof identity]} onChange={(event) => setIdentity((current) => ({ ...current, [field.key]: event.target.value }))} disabled={Boolean(selected.submittedAt)} placeholder={field.placeholder} /></label>)}</div><label>总体满意度<select value={selected.responseData?.score || score} onChange={(event) => setScore(event.target.value)} disabled={Boolean(selected.submittedAt)}><option value="5">5 分 · 非常满意</option><option value="4">4 分 · 满意</option><option value="3">3 分 · 一般</option><option value="2">2 分 · 待改进</option><option value="1">1 分 · 不满意</option></select></label><label>重点关注<input required value={selected.responseData?.focus || focus} onChange={(event) => setFocus(event.target.value)} disabled={Boolean(selected.submittedAt)} placeholder="例如：网络响应、会议室环境" /></label><label>改进建议<textarea required rows={4} value={selected.responseData?.feedback || feedback} onChange={(event) => setFeedback(event.target.value)} disabled={Boolean(selected.submittedAt)} placeholder="请填写具体建议" /></label><button type="submit" className="otto-park-demo__primary" disabled={busy || Boolean(selected.submittedAt)}>{selected.submittedAt ? '已实名提交，不能修改' : busy ? '正在提交…' : '提交问卷'}</button></form> : null}</> : <div className="otto-park-repair__empty">暂无需要填写的满意度调查。</div>}
  </div>;
}

function futureLocalDate(offsetDays = 1): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function meetingTimeToMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function meetingMinutesToTime(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function serviceOptionValue(option: NonNullable<ServiceFormField['options']>[number]): string {
  return typeof option === 'string' ? option : option.value;
}

function serviceOptionLabel(option: NonNullable<ServiceFormField['options']>[number]): string {
  return typeof option === 'string' ? option : option.label;
}

function parkCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency: 'CNY', maximumFractionDigits: 2,
  }).format(value);
}

function ServiceRequestView({ service, onBack, onComplete, focusTicket }: {
  service: ParkService;
  onBack: () => void;
  onComplete: () => void;
  focusTicket: EnterpriseRepairTicket | null;
}): React.JSX.Element {
  const fields = serviceFormFields(service.id);
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
  const [resources, setResources] = useState<EnterpriseParkResources | null>(null);
  const [organizationView, setOrganizationView] = useState<EnterpriseOrganizationView | null>(null);
  const [membershipDefaults, setMembershipDefaults] = useState({ address: '', roomNumber: '' });
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(
    fields.map((field) => [field.key, ''])
      .concat([
        ['roomId', ''],
        ['roomName', ''],
        ['date', futureLocalDate()],
        ['slotKey', ''],
        ['startTime', ''],
        ['endTime', ''],
        ['time', ''],
        ['roomCapacity', ''],
        ['priceHalfDay', ''],
      ]),
  ));
  const [response, setResponse] = useState({ type: '', text: '' });
  const [repairActionMode, setRepairActionMode] = useState<'reply' | 'transfer'>('reply');
  const [transfer, setTransfer] = useState({ memberId: '', department: '', note: '' });
  const [completionNote, setCompletionNote] = useState('');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [session, next, park] = await Promise.all([
        window.otto.enterpriseSession(),
        window.otto.enterpriseTicketList(),
        typeof window.otto.enterpriseParkView === 'function'
          ? window.otto.enterpriseParkView().catch(() => null)
          : Promise.resolve(null),
      ]);
      setAccount(session.account);
      const defaults = {
        address: park?.tenantAddress ?? '',
        roomNumber: park?.tenantRoomNumber ?? '',
      };
      setMembershipDefaults(defaults);
      if (session.account) {
        setForm((current) => ({
          ...current,
          company: current.company || session.account?.organizationName || '',
          address: current.address || defaults.address,
          roomNumber: current.roomNumber || defaults.roomNumber,
          contact: current.contact || session.account?.name || '',
          phone: current.phone || session.account?.phone?.replace(/^\+86/, '') || '',
        }));
      }
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
    if (service.id !== 'meeting-room' || !window.otto?.enterpriseParkResources) {
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
    if (!handlerMode || service.id !== 'repair' || !window.otto?.enterpriseOrganizationView) {
      setOrganizationView(null);
      return undefined;
    }
    let cancelled = false;
    void window.otto.enterpriseOrganizationView()
      .then((view) => { if (!cancelled) setOrganizationView(view); })
      .catch(() => { if (!cancelled) setOrganizationView(null); });
    return () => { cancelled = true; };
  }, [handlerMode, service.id]);

  const selectedRoom = resources?.meetingRooms.find((room) => room.id === form.roomId) ?? null;
  const visibleSlots = resources?.meetingSlots.filter((slot) => (
    slot.roomId === form.roomId && slot.date === form.date
  )) ?? [];
  const selectedMeetingSlots = visibleSlots.filter((slot) => (
    form.startTime && form.endTime
    && slot.slotKey >= form.startTime
    && slot.slotKey < form.endTime
  ));
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
  const historicalTicket = Boolean(activeTicket && isStaffHistoryTicket(activeTicket));
  const historyEntries = activeTicket ? visibleTicketHistory(activeTicket) : [];
  const transferMembers = organizationView?.members.filter((member) => (
    member.status === 'active' && member.id !== account?.id
  )) ?? [];
  const transferDepartments = [...new Set(transferMembers
    .map((member) => member.department?.trim())
    .filter((department): department is string => Boolean(department)))].sort();
  const showActiveTicketDescription = Boolean(activeTicket?.description && !Object.values(
    activeTicket.formData,
  ).some((value) => value.trim() === activeTicket.description.trim()));

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
      startTime: '',
      endTime: '',
      time: '',
      attendees: room && Number(current.attendees) > room.capacity ? '' : current.attendees,
    }));
  };

  const chooseSlot = (slot: EnterpriseParkResources['meetingSlots'][number]): void => {
    if (slot.status !== 'available') return;
    const slotEnd = meetingMinutesToTime(meetingTimeToMinutes(slot.slotKey) + 10);
    setForm((current) => {
      const startTime = !current.startTime || slot.slotKey < current.startTime
        ? slot.slotKey
        : current.startTime;
      const endTime = !current.startTime || slot.slotKey < current.startTime
        ? slotEnd
        : slotEnd;
      const range = visibleSlots.filter((candidate) => (
        candidate.slotKey >= startTime && candidate.slotKey < endTime
      ));
      const expected = (meetingTimeToMinutes(endTime) - meetingTimeToMinutes(startTime)) / 10;
      if (range.length !== expected || range.some((candidate) => candidate.status !== 'available')) {
        setError('所选时间内包含红色已预约或灰色未开放时段，请重新选择连续绿色时段');
        return current;
      }
      setError(null);
      return {
        ...current,
        slotKey: startTime,
        startTime,
        endTime,
        time: `${startTime}–${endTime}`,
      };
    });
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
        if (!normalized.startTime || !normalized.endTime) throw new Error('请在时间轴上选择连续的绿色时段');
        if (!normalized.attendees || attendeeError) throw new Error(attendeeError || '请填写参会人数');
      }
      const primary = normalized.roomName || normalized.area || normalized.applicationType
        || normalized.businessType || normalized.roomNumber || normalized.date || normalized.category || service.name;
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
      replaceTicket(next);
      await refreshResources();
      if (service.id !== 'meeting-room') {
        setForm(Object.fromEntries(fields.map((field) => [
          field.key,
          field.key === 'company' ? account?.organizationName || ''
            : field.key === 'address' ? membershipDefaults.address
              : field.key === 'roomNumber' ? membershipDefaults.roomNumber
                : field.key === 'contact' ? account?.name || ''
            : field.key === 'phone' ? account?.phone?.replace(/^\+86/, '') || ''
              : '',
        ]).concat([
          ['roomId', ''],
          ['roomName', ''],
          ['date', futureLocalDate()],
          ['slotKey', ''],
          ['startTime', ''],
          ['endTime', ''],
          ['time', ''],
          ['roomCapacity', ''],
          ['priceHalfDay', ''],
        ])));
      }
      onComplete();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const action = async (
    ticket: EnterpriseRepairTicket,
    actionName: 'respond' | 'accept' | 'complete' | 'confirm' | 'transfer',
    extra: {
      responseType?: string;
      responseText?: string;
      transferAccountId?: string;
      transferDepartment?: string;
    } = {},
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.otto.enterpriseTicketAction(ticket.id, {
        action: actionName,
        ...(actionName === 'respond'
          ? { responseType: response.type, responseText: response.text }
          : {}),
        ...extra,
      });
      replaceTicket(next);
      if (actionName === 'respond') setResponse({ type: '', text: '' });
      if (['respond', 'complete', 'transfer', 'confirm'].includes(actionName)) onComplete();
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
      <form className="otto-park-request-form" onSubmit={(event) => { void submitTicket(event); }} aria-label={`${service.name}申请表`}>
        <div className="otto-park-form__guide">
          <strong>填写申请</strong>
          <span>{service.id === 'meeting-room' ? '按顺序选择会议室、日期和绿色可预约时段。红色表示该时段已经被占用。' : interaction.hint}</span>
        </div>
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
                startTime: '',
                endTime: '',
                time: '',
              }))}
            />
          </label>
          <fieldset className="otto-park-meeting-slots">
            <legend>使用时间</legend>
            {!form.roomId ? <p>请先选择会议室</p> : visibleSlots.length ? <>
              <div className="otto-park-meeting-timeline-scroll">
                <div className="otto-park-meeting-timeline__hours" aria-hidden>
                  {Array.from({ length: 15 }, (_, index) => <span key={index}>{String(9 + index).padStart(2, '0')}:00</span>)}
                </div>
                <div className="otto-park-meeting-timeline" role="group" aria-label="09:00 到 23:00 会议室预约时间轴">
                  {visibleSlots.map((slot) => {
                    const selectedSlot = selectedMeetingSlots.some((item) => item.id === slot.id);
                    return <button
                      key={slot.id}
                      type="button"
                      disabled={slot.status !== 'available'}
                      className={`is-${slot.status} ${selectedSlot ? 'is-selected' : ''}`}
                      onClick={() => chooseSlot(slot)}
                      aria-label={`${slot.label}，${slot.status === 'available' ? '可预约' : slot.status === 'booked' ? '已预约' : '未开放'}`}
                      title={`${slot.label} · ${slot.status === 'available' ? '可预约' : slot.status === 'booked' ? '已预约' : '未开放'}`}
                    />;
                  })}
                </div>
              </div>
              <div className="otto-park-meeting-selection">
                <span>{form.startTime && form.endTime ? `已选择 ${form.startTime}–${form.endTime}` : '点击绿色格子选择开始时间，再点击后续绿色格子延长时间'}</span>
                {form.startTime ? <button type="button" onClick={() => setForm((current) => ({ ...current, slotKey: '', startTime: '', endTime: '', time: '' }))}>重新选择</button> : null}
              </div>
            </> : <p>该日期暂时没有园区发布的可预约时段</p>}
            <div className="otto-park-meeting-legend">
              <span className="is-available">绿色 · 可预约</span>
              <span className="is-booked">红色 · 已预约</span>
              <span className="is-selected">深绿 · 已选择</span>
            </div>
          </fieldset>
        </div> : null}

        <div className="otto-park-form__grid">
          {fields.map((field) => <React.Fragment key={field.key}>
            <label className={`otto-park-form__field ${field.key === 'meetingContent' ? 'is-wide' : ''}`}>
              {field.label}
              {field.options && !field.allowCustom ? <select
                aria-label={field.label}
                required
                value={form[field.key] || ''}
                onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
              >
                <option value="">{field.placeholder}</option>
                {field.options.map((option) => <option key={serviceOptionValue(option)} value={serviceOptionValue(option)}>{serviceOptionLabel(option)}</option>)}
              </select> : field.allowCustom ? <>
                <input
                  aria-label={field.label}
                  required
                  list={`otto-park-${service.id}-${field.key}-options`}
                  value={form[field.key] || ''}
                  placeholder={field.placeholder}
                  onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
                />
                <datalist id={`otto-park-${service.id}-${field.key}-options`}>
                  {field.options?.map((option) => <option key={serviceOptionValue(option)} value={serviceOptionValue(option)}>{serviceOptionLabel(option)}</option>)}
                </datalist>
              </> : field.inputType === 'textarea' ? <textarea
                aria-label={field.label}
                required
                rows={3}
                value={form[field.key] || ''}
                placeholder={field.placeholder}
                onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
              /> : <input
                aria-label={field.label}
                required
                type={field.inputType || 'text'}
                min={field.inputType === 'date' ? futureLocalDate(0) : field.min}
                max={service.id === 'meeting-room' && field.key === 'attendees' && selectedRoom ? selectedRoom.capacity : field.max}
                step={field.inputType === 'number' ? 1 : undefined}
                value={form[field.key] || ''}
                placeholder={field.placeholder}
                onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))}
              />}
              {field.key === 'attendees' && selectedRoom
                ? <small className={attendeeError ? 'is-error' : ''}>{attendeeError || `最多可填写 ${selectedRoom.capacity} 人`}</small>
                : null}
            </label>
            {service.id === 'vehicle-visit' && field.key === 'vehicleCount'
              ? Array.from({ length: Math.max(0, Math.min(20, Number(form.vehicleCount) || 0)) }, (_, index) => <label key={`plate${index + 1}`} className="otto-park-form__field">
                第 {index + 1} 辆车车牌号
                <input aria-label={`第 ${index + 1} 辆车车牌号`} required value={form[`plate${index + 1}`] || ''} placeholder="例如：京 A·12345" onChange={(event) => setForm((current) => ({ ...current, [`plate${index + 1}`]: event.target.value }))} />
              </label>)
              : null}
          </React.Fragment>)}
        </div>
        <button
          type="submit"
          className="otto-park-demo__primary"
          disabled={busy || (service.id === 'meeting-room' && (!form.roomId || !form.startTime || !form.endTime || Boolean(attendeeError)))}
        >
          {busy ? '正在提交…' : `提交${service.name}申请`}
        </button>
      </form>

      {ownTickets.length ? <div className="otto-park-technician-form">
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
        <strong>{historicalTicket
          ? service.id === 'repair' ? '维修服务历史' : '园区服务历史'
          : service.id === 'repair' ? '维修待办' : '客服待办'}</strong>
        <span>{historicalTicket
          ? '这里展示申请人填写的资料、全部处理记录和最终结果。'
          : '这里仅显示分配给当前账号的真实申请。'}</span>
      </div>
      {assignedTickets.length ? <>
        <div className="otto-park-repair__roles">{assignedTickets.map((ticket) => <button key={ticket.id} type="button" className={activeTicket?.id === ticket.id ? 'is-active' : ''} onClick={() => { void openAssigned(ticket); }}>{ticket.title} · {ticket.status}{!ticket.readAt ? ' · 新' : ''}</button>)}</div>
        {activeTicket?.isRecipient ? <>
          {historicalTicket ? <div className="otto-park-history-readonly" role="status">
            <strong>历史记录只读</strong>
            <span>该服务已进入验收或完成阶段，申请内容和每次处理结果均已留存。</span>
          </div> : null}
          <div className="otto-park-request-summary">
            <div><span>申请人</span><strong>{activeTicket.creator.name}</strong></div>
            {visibleTicketFormEntries(activeTicket).map(([key, value]) => <div key={key}>
              <span>{ticketFieldLabel(activeTicket.serviceId, key)}</span>
              <strong>{value || '未填写'}</strong>
            </div>)}
            {showActiveTicketDescription ? <div className="is-wide"><span>申请说明</span><strong>{activeTicket.description}</strong></div> : null}
            <div><span>最终状态</span><strong>{activeTicket.status}</strong></div>
            <div><span>最新办理结果</span><strong>{activeTicket.responseType || '暂无办理回复'}</strong></div>
            <div className="is-wide"><span>最新结果说明</span><strong>{activeTicket.responseText || '暂无'}</strong></div>
          </div>
          <section className="otto-park-ticket-history" aria-label="园区服务处理历史">
            <div className="otto-park-ticket-history__head"><strong>处理记录</strong><span>{historyEntries.length} 条 · 按时间顺序</span></div>
            <ol>{historyEntries.map((entry) => <li key={entry.id}>
              <span className="otto-park-ticket-history__marker" aria-hidden />
              <div>
                <div className="otto-park-ticket-history__meta">
                  <strong>{HISTORY_ACTION_LABELS[entry.action]}</strong>
                  <time dateTime={entry.createdAt}>{formatParkTimestamp(entry.createdAt)}</time>
                </div>
                <p>{entry.actor?.name || '历史处理人员'} · 状态：{entry.statusAfter}</p>
                {entry.responseType ? <p><b>{entry.responseType}</b>{entry.responseText ? `：${entry.responseText}` : ''}</p> : null}
              </div>
            </li>)}</ol>
          </section>
          {!historicalTicket ? <>
            {service.id !== 'repair' ? <form className="otto-park-response-form" onSubmit={(event) => { event.preventDefault(); void action(activeTicket, 'respond'); }} aria-label="园区服务回复表">
              <label className="otto-park-form__field">处理方式
                <input required list={`otto-park-response-${service.id}`} value={response.type} onChange={(event) => setResponse((current) => ({ ...current, type: event.target.value }))} placeholder="选择或输入处理方式" />
                <datalist id={`otto-park-response-${service.id}`}>{interaction.quickReplies.map((reply) => <option key={reply} value={reply} />)}</datalist>
              </label>
              <label className="otto-park-form__field">给申请人的说明
                <textarea required rows={4} value={response.text} onChange={(event) => setResponse((current) => ({ ...current, text: event.target.value }))} placeholder="请说明办理结果或后续安排" />
              </label>
              <button type="submit" className="otto-park-demo__primary" disabled={busy || !response.type.trim() || !response.text.trim()}>发送办理回复</button>
            </form> : activeTicket.status === '已转交' ? <form className="otto-park-response-form" onSubmit={(event) => {
              event.preventDefault();
              void action(activeTicket, 'complete', {
                responseType: '已完成工作',
                responseText: completionNote,
              });
            }} aria-label="完成转交的物业报修">
              <div className="otto-park-form__guide"><strong>完成现场工作</strong><span>请填写实际处理结果，完成后申请人和原客服都会收到通知。</span></div>
              <label className="otto-park-form__field">工作完成说明
                <textarea required rows={4} value={completionNote} onChange={(event) => setCompletionNote(event.target.value)} placeholder="例如：已更换损坏灯具并完成通电测试" />
              </label>
              <button type="submit" className="otto-park-demo__primary" disabled={busy || !completionNote.trim()}>已完成工作</button>
            </form> : <div className="otto-park-repair-actions">
              <div className="otto-park-repair-actions__modes" role="tablist" aria-label="物业报修处理方式">
                <button type="button" role="tab" aria-selected={repairActionMode === 'reply'} className={repairActionMode === 'reply' ? 'is-active' : ''} onClick={() => setRepairActionMode('reply')}>客服回复</button>
                <button type="button" role="tab" aria-selected={repairActionMode === 'transfer'} className={repairActionMode === 'transfer' ? 'is-active' : ''} onClick={() => setRepairActionMode('transfer')}>转交工作人员</button>
              </div>
              {repairActionMode === 'reply' ? <form className="otto-park-response-form" onSubmit={(event) => { event.preventDefault(); void action(activeTicket, 'respond'); }} aria-label="物业报修客服回复">
                <label className="otto-park-form__field">处理方式
                  <input required list="otto-park-repair-response-options" value={response.type} onChange={(event) => setResponse((current) => ({ ...current, type: event.target.value }))} placeholder="选择或输入处理方式" />
                  <datalist id="otto-park-repair-response-options">{interaction.quickReplies.map((reply) => <option key={reply} value={reply} />)}</datalist>
                </label>
                <label className="otto-park-form__field">给申请人的说明
                  <textarea required rows={4} value={response.text} onChange={(event) => setResponse((current) => ({ ...current, text: event.target.value }))} placeholder="说明处理建议、预约时间或需要补充的信息" />
                </label>
                <button type="submit" className="otto-park-demo__primary" disabled={busy || !response.type.trim() || !response.text.trim()}>发送客服回复</button>
              </form> : <form className="otto-park-response-form" onSubmit={(event) => {
                event.preventDefault();
                void action(activeTicket, 'transfer', {
                  transferAccountId: transfer.memberId || undefined,
                  transferDepartment: transfer.memberId ? undefined : transfer.department || undefined,
                  responseText: transfer.note.trim() || undefined,
                });
              }} aria-label="转交物业报修">
                <div className="otto-park-transfer-grid">
                  <label className="otto-park-form__field">转交给同事
                    <select value={transfer.memberId} onChange={(event) => setTransfer((current) => ({ ...current, memberId: event.target.value, department: event.target.value ? '' : current.department }))}>
                      <option value="">请选择具体同事</option>
                      {transferMembers.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.department || member.positionTitle || '未分配部门'}</option>)}
                    </select>
                  </label>
                  <label className="otto-park-form__field">或转交给部门
                    <select value={transfer.department} onChange={(event) => setTransfer((current) => ({ ...current, department: event.target.value, memberId: event.target.value ? '' : current.memberId }))}>
                      <option value="">请选择部门</option>
                      {transferDepartments.map((department) => <option key={department}>{department}</option>)}
                    </select>
                  </label>
                </div>
                <label className="otto-park-form__field">转交说明
                  <textarea rows={3} value={transfer.note} onChange={(event) => setTransfer((current) => ({ ...current, note: event.target.value }))} placeholder="例如：请工程部上门检查配电箱并反馈处理结果" />
                </label>
                <button type="submit" className="otto-park-demo__primary" disabled={busy || (!transfer.memberId && !transfer.department)}>确认转交并通知工作人员</button>
              </form>}
            </div>}
          </> : null}
        </> : null}
      </> : <div className="otto-park-repair__empty">当前没有分配给你的待办。</div>}
    </div>}
  </div>;
}

function ServiceDemo({ service, onBack, onComplete, focusTicket }: { service: ParkService; onBack: () => void; onComplete: () => void; focusTicket: EnterpriseRepairTicket | null }): React.JSX.Element {
  if (service.id === 'announcement') return <AnnouncementView onBack={onBack} />;
  if (service.id === 'satisfaction') return <SatisfactionView onBack={onBack} />;
  return <ServiceRequestView service={service} onBack={onBack} onComplete={onComplete} focusTicket={focusTicket} />;
}

export function ParkServicesPlugin(): React.JSX.Element {
  const [parkEnabled, setParkEnabled] = useState(() => typeof window.otto?.enterpriseParkView !== 'function');
  const [parkAdminOrganization, setParkAdminOrganization] = useState(false);
  const [parkStatistics, setParkStatistics] = useState<EnterpriseParkStatistics | null>(null);
  const [parkStatisticsError, setParkStatisticsError] = useState('');
  const [expandedOrganizationId, setExpandedOrganizationId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  const [services, setServices] = useState<ParkService[]>(() => defaultServices(DEFAULT_PARK));
  const [selected, setSelected] = useState<ParkService | null>(null);
  const [backgroundTickets, setBackgroundTickets] = useState<EnterpriseRepairTicket[]>([]);
  const [backgroundTicketSummaryCount, setBackgroundTicketSummaryCount] = useState(0);
  const [backgroundPublication, setBackgroundPublication] = useState<EnterpriseParkPublication | null>(null);
  const [focusTicket, setFocusTicket] = useState<EnterpriseRepairTicket | null>(null);
  const [assignedTasks, setAssignedTasks] = useState<EnterpriseRepairTicket[]>([]);
  const [assignedHistory, setAssignedHistory] = useState<EnterpriseRepairTicket[]>([]);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyCategory, setHistoryCategory] = useState('all');
  const [historySort, setHistorySort] = useState<'desc' | 'asc'>('desc');
  const [pendingNotificationSessionId, setPendingNotificationSessionId] = useState<string | null>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const notifiedTicketKeys = useRef(new Set<string>());
  const ticketPollIdentity = useRef<string | null>(null);
  const ticketPollInitialized = useRef(false);
  const notifiedPublicationKeys = useRef(new Set<string>());
  const uid = useId();
  const titleId = `${uid}-title`;

  const historyCategoryOptions = useMemo(() => {
    const configuredNames = new Map(services.map((service) => [service.id, service.name]));
    return baseDefaultServices(DEFAULT_PARK).map((service) => ({
      id: service.id,
      name: configuredNames.get(service.id) || service.name,
    }));
  }, [services]);
  const visibleAssignedHistory = useMemo(() => {
    const query = historyQuery.trim().toLocaleLowerCase('zh-CN');
    return assignedHistory
      .filter((ticket) => historyCategory === 'all' || ticket.serviceId === historyCategory)
      .filter((ticket) => {
        if (!query) return true;
        const historyText = (ticket.history ?? []).flatMap((entry) => [
          entry.actor?.name,
          entry.responseType,
          entry.responseText,
          entry.statusAfter,
        ]);
        return [
          ticket.title,
          ticket.description,
          ticket.status,
          ticket.category,
          ticket.location,
          ticket.creator.name,
          ticket.responseType,
          ticket.responseText,
          ...Object.values(ticket.formData),
          ...historyText,
        ].filter(Boolean).join('\n').toLocaleLowerCase('zh-CN').includes(query);
      })
      .sort((left, right) => (historySort === 'desc' ? -1 : 1) * (
        ticketLatestTimestamp(left) - ticketLatestTimestamp(right)
      ));
  }, [assignedHistory, historyCategory, historyQuery, historySort]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const enterpriseParkView = window.otto?.enterpriseParkView;
      if (typeof enterpriseParkView === 'function') {
        try {
          const park = await enterpriseParkView();
          if (!park || park.status !== 'active') {
            if (!cancelled) {
              setParkEnabled(false);
              setParkAdminOrganization(false);
              setBrand('');
              setServices(defaultServices(DEFAULT_PARK));
            }
            return;
          }
          if (!cancelled) {
            setParkEnabled(true);
            setParkAdminOrganization(Boolean(park.isAdminOrganization));
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
            setParkEnabled(false);
            setParkAdminOrganization(false);
            setBrand('');
            setServices(defaultServices(DEFAULT_PARK));
          }
        }
        return;
      }
      // 旧 preload 兼容：没有 enterpriseParkView 时才允许本机园区配置。
      const cfg = await window.otto?.parkConfig?.().catch(() => null);
      if (cancelled) return;
      setParkEnabled(true);
      setParkAdminOrganization(false);
      if (!cfg) return;
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
    if (!parkAdminOrganization) {
      setParkStatistics(null);
      setParkStatisticsError('');
      setExpandedOrganizationId(null);
      return undefined;
    }
    if (!open) return undefined;

    let cancelled = false;
    const refreshStatistics = async (): Promise<void> => {
      try {
        if (typeof window.otto?.enterpriseParkStatistics !== 'function') {
          throw new Error('当前 Otto 版本尚未提供园区统计，请更新客户端。');
        }
        const statistics = await window.otto.enterpriseParkStatistics();
        if (!cancelled) {
          setParkStatistics(statistics);
          setParkStatisticsError('');
        }
      } catch (error) {
        if (!cancelled) {
          setParkStatisticsError(error instanceof Error ? error.message : '园区统计读取失败，请稍后重试。');
        }
      }
    };

    void refreshStatistics();
    const timer = window.setInterval(() => { void refreshStatistics(); }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, parkAdminOrganization]);

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
    const onPublicationHandled = (event: Event): void => {
      const id = event instanceof CustomEvent && typeof event.detail?.id === 'string'
        ? event.detail.id
        : '';
      if (!id) return;
      notifiedPublicationKeys.current.add(id);
      setBackgroundPublication((current) => current?.id === id ? null : current);
    };
    window.addEventListener('otto:park-publication-handled', onPublicationHandled);
    return () => window.removeEventListener('otto:park-publication-handled', onPublicationHandled);
  }, []);

  useEffect(() => {
    const showParkSession = (sessionId?: string): void => {
      setSelected(null);
      setFocusTicket(null);
      setPendingNotificationSessionId(sessionId?.startsWith('park:') ? sessionId : null);
      setOpen(true);
    };
    const onOpen = (event: Event): void => {
      const sessionId = event instanceof CustomEvent && typeof event.detail?.sessionId === 'string'
        ? event.detail.sessionId
        : undefined;
      showParkSession(sessionId);
    };
    const unsubscribeNotification = window.otto.onNotificationSessionOpen?.((sessionId) => {
      if (sessionId.startsWith('park:')) showParkSession(sessionId);
    }) ?? (() => {});
    window.addEventListener(PARK_OPEN_EVENT, onOpen);
    return () => {
      unsubscribeNotification();
      window.removeEventListener(PARK_OPEN_EVENT, onOpen);
    };
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
          setAssignedHistory([]);
          setBackgroundTickets([]);
          setBackgroundTicketSummaryCount(0);
          notifiedTicketKeys.current.clear();
          ticketPollIdentity.current = null;
          ticketPollInitialized.current = false;
          return;
        }
        const identity = `${session.account.organizationId}:${session.account.id}`;
        if (ticketPollIdentity.current !== identity) {
          ticketPollIdentity.current = identity;
          ticketPollInitialized.current = false;
          notifiedTicketKeys.current.clear();
          setAssignedHistory([]);
          setBackgroundTickets([]);
          setBackgroundTicketSummaryCount(0);
        }
        const tickets = await window.otto.enterpriseTicketList();
        if (cancelled) return;
        const actionableTasks = tickets.filter(isActionableStaffTicket);
        const completedHistory = tickets.filter(isStaffHistoryTicket);
        const latestTickets = new Map(tickets.map((ticket) => [ticket.id, ticket]));
        setAssignedTasks(actionableTasks);
        setAssignedHistory(completedHistory);
        setBackgroundTickets((current) => current
          .map((ticket) => latestTickets.get(ticket.id) ?? ticket)
          .filter((ticket) => (
            ticket.isRecipient ? isActionableStaffTicket(ticket) : ticket.status !== '已完成'
          )));
        setBackgroundTicketSummaryCount((current) => current > 0 ? actionableTasks.length : 0);

        for (const ticket of tickets.filter((item) => item.isRecipient && !isActionableStaffTicket(item))) {
          const settledKey = `settled:${ticket.id}:${ticket.status}`;
          if (notifiedTicketKeys.current.has(settledKey)) continue;
          notifiedTicketKeys.current.add(settledKey);
          void window.otto.notificationMarkRead?.(`park:ticket:${ticket.id}`).catch(() => undefined);
        }

        const assignedCandidates = actionableTasks.filter((ticket) => (
          !ticket.readAt && !notifiedTicketKeys.current.has(assignedNotificationKey(ticket))
        ));
        const creatorCandidates = tickets.filter((ticket) => (
          ticket.isCreator
          && Boolean(ticket.responseAt || ticket.status === '待验收')
          && !notifiedTicketKeys.current.has(creatorUpdateNotificationKey(ticket))
        ));
        const transferredCompletionCandidates = tickets.filter((ticket) => (
          ticket.isRecipient
          && ticket.deliveryStatus === 'transferred'
          && ticket.status === '已完成'
          && !notifiedTicketKeys.current.has(creatorUpdateNotificationKey(ticket))
        ));

        if (!ticketPollInitialized.current) {
          ticketPollInitialized.current = true;
          for (const ticket of assignedCandidates) notifiedTicketKeys.current.add(assignedNotificationKey(ticket));
          for (const ticket of creatorCandidates) notifiedTicketKeys.current.add(creatorUpdateNotificationKey(ticket));
          for (const ticket of transferredCompletionCandidates) {
            notifiedTicketKeys.current.add(creatorUpdateNotificationKey(ticket));
          }

          if (assignedCandidates.length > 1) {
            const title = 'Otto 待处理提醒 · 园区服务';
            const body = `你有 ${assignedCandidates.length} 项尚未处理的园区任务，已为你汇总到待办列表。`;
            setBackgroundTicketSummaryCount(actionableTasks.length);
            showParkNotification({
              messageId: `park-ticket-summary:${identity}:${assignedCandidates.map((ticket) => ticket.id).sort().join(',')}`,
              sessionId: 'park:service',
              source: 'park',
              title,
              preview: body,
            }, title, body);
            return;
          }
        }

        if (assignedCandidates.length > 1) {
          for (const ticket of assignedCandidates) notifiedTicketKeys.current.add(assignedNotificationKey(ticket));
          const title = 'Otto 新任务提醒 · 园区服务';
          const body = `新收到 ${assignedCandidates.length} 项园区任务，当前共 ${actionableTasks.length} 项待处理。`;
          setBackgroundTicketSummaryCount(actionableTasks.length);
          showParkNotification({
            messageId: `park-ticket-batch:${identity}:${assignedCandidates.map((ticket) => ticket.id).sort().join(',')}`,
            sessionId: 'park:service',
            source: 'park',
            title,
            preview: body,
          }, title, body);
        } else if (assignedCandidates.length === 1) {
          const candidate = assignedCandidates[0];
          notifiedTicketKeys.current.add(assignedNotificationKey(candidate));
          const title = 'Otto 待处理提醒 · 园区服务';
          const body = `${candidate.creator.name}：${candidate.location || candidate.title} · ${candidate.description}`;
          showParkNotification({
            messageId: `park-ticket:${candidate.id}:${candidate.updatedAt}`,
            sessionId: `park:ticket:${candidate.id}`,
            source: 'park',
            title,
            sender: candidate.creator.name,
            preview: body,
          }, title, body);
          setBackgroundTickets((current) => [
            candidate,
            ...current.filter((ticket) => ticket.id !== candidate.id),
          ].slice(0, 5));
        }

        for (const candidate of [...creatorCandidates, ...transferredCompletionCandidates]) {
          const key = creatorUpdateNotificationKey(candidate);
          if (notifiedTicketKeys.current.has(key)) continue;
          notifiedTicketKeys.current.add(key);
          const title = candidate.isCreator
            ? 'Otto 园区服务进度提醒'
            : 'Otto 转交任务已完成';
          const body = `${candidate.location || candidate.title} · ${candidate.responseType || candidate.status}`;
          showParkNotification({
            messageId: `park-ticket:${candidate.id}:${candidate.updatedAt}`,
            sessionId: `park:ticket:${candidate.id}`,
            source: 'park',
            title,
            preview: body,
          }, title, body);
          setBackgroundTickets((current) => [
            candidate,
            ...current.filter((ticket) => ticket.id !== candidate.id),
          ].slice(0, 5));
        }
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

  const openTicket = useCallback((ticket: EnterpriseRepairTicket): void => {
    const service = services.find((item) => item.id === (ticket.serviceId || 'repair'))
      ?? services.find((item) => item.id === 'repair');
    if (service) {
      setFocusTicket(ticket);
      setSelected(service);
      setOpen(true);
    }
  }, [services]);

  const markAssignedTicketsViewed = useCallback((tickets: EnterpriseRepairTicket[]): void => {
    const unread = tickets.filter((ticket) => ticket.isRecipient && !ticket.readAt);
    if (!unread.length) return;
    void Promise.all(unread.map(async (ticket) => {
      try {
        return await window.otto.enterpriseTicketRead(ticket.id);
      } catch {
        return null;
      }
    })).then((viewed) => {
      const updates = new Map(viewed
        .filter((ticket): ticket is EnterpriseRepairTicket => Boolean(ticket))
        .map((ticket) => [ticket.id, ticket]));
      if (!updates.size) return;
      const applyUpdates = (current: EnterpriseRepairTicket[]): EnterpriseRepairTicket[] => current.map(
        (ticket) => updates.get(ticket.id) ?? ticket,
      );
      setAssignedTasks(applyUpdates);
      setAssignedHistory(applyUpdates);
      setBackgroundTickets(applyUpdates);
      setFocusTicket((current) => current ? updates.get(current.id) ?? current : current);
    });
  }, []);

  const openAssignedTicket = useCallback((ticket: EnterpriseRepairTicket): void => {
    openTicket(ticket);
    markAssignedTicketsViewed([ticket]);
    void window.otto.notificationMarkRead?.(`park:ticket:${ticket.id}`).catch(() => undefined);
  }, [markAssignedTicketsViewed, openTicket]);

  const openBackgroundTicket = (ticket: EnterpriseRepairTicket): void => {
    openAssignedTicket(ticket);
    setBackgroundTickets((current) => current.filter((item) => item.id !== ticket.id));
  };

  const openBackgroundTicketSummary = (): void => {
    markAssignedTicketsViewed(assignedTasks);
    setSelected(null);
    setFocusTicket(null);
    setOpen(true);
    setBackgroundTicketSummaryCount(0);
    void window.otto.notificationMarkRead?.('park:service').catch(() => undefined);
  };

  useEffect(() => {
    const sessionId = pendingNotificationSessionId;
    if (!sessionId) return;
    if (sessionId === 'park:service') {
      if (!assignedTasks.length) return;
      markAssignedTicketsViewed(assignedTasks);
      setPendingNotificationSessionId(null);
      setBackgroundTicketSummaryCount(0);
      void window.otto.notificationMarkRead?.(sessionId).catch(() => undefined);
      return;
    }
    if (!sessionId.startsWith('park:ticket:')) {
      setPendingNotificationSessionId(null);
      return;
    }
    const ticketId = sessionId.slice('park:ticket:'.length);
    const ticket = assignedTasks.find((item) => item.id === ticketId)
      ?? backgroundTickets.find((item) => item.id === ticketId);
    if (!ticket) return;
    openAssignedTicket(ticket);
    setPendingNotificationSessionId(null);
    setBackgroundTickets((current) => current.filter((item) => item.id !== ticket.id));
    void window.otto.notificationMarkRead?.(sessionId).catch(() => undefined);
  }, [assignedTasks, backgroundTickets, markAssignedTicketsViewed, openAssignedTicket, pendingNotificationSessionId]);

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
          <ServiceDemo service={selected} onBack={() => { setSelected(null); setFocusTicket(null); }} onComplete={close} focusTicket={focusTicket} />
        ) : (
          <div className="otto-park-dialog__landing">
            {parkAdminOrganization ? <section className="otto-park-statistics" aria-label="产业园服务统计">
              <div className="otto-park-statistics__head">
                <div>
                  <strong>产业园服务统计</strong>
                  <span>按真实服务申请汇总，不包含公告和问卷。</span>
                </div>
                <time dateTime={parkStatistics?.generatedAt}>
                  {parkStatistics
                    ? '更新于 ' + formatParkTimestamp(parkStatistics.generatedAt)
                    : parkStatisticsError ? '统计暂不可用' : '正在读取'}
                </time>
              </div>
              {parkStatisticsError ? <div className="otto-park-statistics__error" role="alert">{parkStatisticsError}</div> : parkStatistics ? <>
                <div className="otto-park-statistics__metrics">
                  <div><span>入驻企业</span><strong>{parkStatistics.organizationCount}</strong><small>{parkStatistics.activeOrganizationCount} 家正常使用</small></div>
                  <div><span>服务使用</span><strong>{parkStatistics.totalServiceUses}</strong><small>七类服务累计</small></div>
                  <div><span>车辆来访</span><strong>{parkStatistics.vehicleVisits}</strong><small>已提交次数</small></div>
                  <div><span>会议室预约</span><strong>{parkStatistics.meetingRoomBookings}</strong><small>成功占用时段</small></div>
                  <div><span>累计金额</span><strong>{parkCurrency(parkStatistics.totalAmountCny)}</strong><small>按申请价格与数量汇总</small></div>
                  <div><span>每月持续费用</span><strong>{parkCurrency(parkStatistics.recurringMonthlyCny)}</strong><small>固话、专线等月费</small></div>
                </div>
                <div className="otto-park-statistics__organizations">
                  <div className="otto-park-statistics__organizations-head">
                    <strong>企业服务使用情况</strong>
                    <span>点击企业查看各项服务次数</span>
                  </div>
                  {parkStatistics.organizations.length ? parkStatistics.organizations.map((organization, index) => {
                    const expanded = expandedOrganizationId === organization.organizationId;
                    const detailId = uid + '-park-statistics-' + index;
                    const location = [organization.address, organization.roomNumber].filter(Boolean).join(' · ');
                    return <div className="otto-park-statistics__organization" key={organization.organizationId}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        onClick={() => setExpandedOrganizationId(expanded ? null : organization.organizationId)}
                      >
                        <span className="otto-park-statistics__organization-name">
                          <strong>{organization.name}</strong>
                          <small>{location || '尚未填写园区地址'}{organization.status === 'disabled' ? ' · 已停用' : ''}</small>
                        </span>
                        <span className="otto-park-statistics__organization-total"><strong>{organization.totalUses}</strong><small>{parkCurrency(organization.totalAmountCny)}</small></span>
                        <span className="otto-park-statistics__organization-last"><small>最近使用</small><span>{organization.lastUsedAt ? formatParkTimestamp(organization.lastUsedAt) : '暂无记录'}</span></span>
                        <IconChevronDown size={16} className={expanded ? 'is-expanded' : undefined} />
                      </button>
                      {expanded ? <div className="otto-park-statistics__service-counts" id={detailId}>
                        {organization.services.map((service) => <div key={service.serviceId}>
                          <span>{service.name}</span>
                          <strong>{service.count} 次 · {parkCurrency(service.amountCny)}</strong>
                          <small>{service.recurringMonthlyCny ? `每月 ${parkCurrency(service.recurringMonthlyCny)} · ` : ''}{service.firstUsedAt ? `${formatParkTimestamp(service.firstUsedAt)} 至 ${formatParkTimestamp(service.lastUsedAt || service.firstUsedAt)}` : '暂无使用记录'}</small>
                        </div>)}
                      </div> : null}
                    </div>;
                  }) : <div className="otto-park-statistics__empty">当前还没有企业加入这个产业园。</div>}
                </div>
              </> : <div className="otto-park-statistics__loading">正在汇总园区服务数据...</div>}
            </section> : null}
            {assignedTasks.length || assignedHistory.length ? <div className="otto-park-staff-workspace">
              {assignedTasks.length ? <section className="otto-park-staff-tasks" aria-label="我的园区待办">
                <div className="otto-park-staff-panel__head"><strong>我的园区待办</strong><span>{assignedTasks.length} 项待处理 · 仅工作人员可见</span></div>
                <div className="otto-park-staff-tasks__items">{assignedTasks.map((ticket) => <button key={ticket.id} type="button" onClick={() => openAssignedTicket(ticket)} aria-label={`打开工作人员待办：${ticket.title}`}><span>{ticket.title}</span><em>{ticket.status} {!ticket.readAt ? '· 新' : ''}</em></button>)}</div>
              </section> : null}
              {assignedHistory.length ? <section className="otto-park-staff-history" aria-label="我的园区服务历史记录">
                <div className="otto-park-staff-panel__head"><strong>我的园区服务历史记录</strong><span>{visibleAssignedHistory.length} / {assignedHistory.length} 条 · 仅工作人员可见</span></div>
                <div className="otto-park-staff-history__controls">
                  <input
                    type="search"
                    aria-label="搜索园区服务历史"
                    value={historyQuery}
                    onChange={(event) => setHistoryQuery(event.target.value)}
                    placeholder="搜索企业、联系人、地址或处理内容"
                  />
                  <select aria-label="园区历史分类" value={historyCategory} onChange={(event) => setHistoryCategory(event.target.value)}>
                    <option value="all">全部 9 类</option>
                    {historyCategoryOptions.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
                  </select>
                  <select aria-label="园区历史排序" value={historySort} onChange={(event) => setHistorySort(event.target.value as 'desc' | 'asc')}>
                    <option value="desc">时间从新到旧</option>
                    <option value="asc">时间从旧到新</option>
                  </select>
                </div>
                <div className="otto-park-staff-history__items">
                  {visibleAssignedHistory.length ? visibleAssignedHistory.map((ticket) => {
                    const serviceName = historyCategoryOptions.find((service) => service.id === ticket.serviceId)?.name || ticket.serviceId;
                    const latestTime = (ticket.history ?? []).at(-1)?.createdAt || ticket.responseAt || ticket.updatedAt;
                    return <button key={ticket.id} type="button" onClick={() => openAssignedTicket(ticket)} aria-label={`打开园区历史：${ticket.title}`}>
                      <span><b>{serviceName}</b><em>{ticket.status}</em></span>
                      <strong>{ticket.title}</strong>
                      <small>{ticket.creator.name} · {formatParkTimestamp(latestTime)}</small>
                      <p>{ticket.responseType || '办理完成'}{ticket.responseText ? `：${ticket.responseText}` : ''}</p>
                    </button>;
                  }) : <div className="otto-park-staff-history__empty">没有符合当前搜索和分类条件的历史记录。</div>}
                </div>
              </section> : null}
            </div> : null}
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
  {(backgroundTicketSummaryCount || backgroundTickets.length || backgroundPublication) ? <div className="otto-park-toast-stack" aria-live="polite">
    {backgroundTicketSummaryCount ? (
      <button type="button" className="otto-park-toast otto-park-toast--result" onClick={openBackgroundTicketSummary} aria-label="打开园区待办汇总">
        <span>Otto 园区服务</span>
        <strong>{backgroundTicketSummaryCount} 项任务待处理</strong>
        <em>已合并历史提醒 · 点击查看待办列表</em>
      </button>
    ) : null}
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
