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

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  EnterpriseAccount,
  EnterpriseParkPublication,
  EnterpriseParkResources,
  EnterpriseParkStatistics,
  EnterpriseRepairTicket,
  EnterpriseRepairTicketHistoryEntry,
} from '../../preload/index.js';
import defaultMeetingRoomImage from '../assets/meeting-room-default.png';
import type { ParkModuleTarget } from '../moduleCatalog.js';
import { parkISODate, parkMinuteOfDay } from '../parkBusinessTime.js';
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
const MEETING_SLOT_MINUTES = 30;
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

function ticketApplicationNumber(ticket: EnterpriseRepairTicket): string {
  return (ticket as EnterpriseRepairTicket & { applicationNumber?: string | null }).applicationNumber
    || ticket.id.slice(-8).toUpperCase();
}

function assignedNotificationKey(ticket: EnterpriseRepairTicket): string {
  return `assigned:${ticket.id}`;
}

function creatorUpdateTimestamp(ticket: EnterpriseRepairTicket): number {
  if (ticket.creatorUpdateAt) return parkTimestamp(ticket.creatorUpdateAt);
  if (ticket.responseAt) return parkTimestamp(ticket.responseAt);
  const staffHistory = (ticket.history ?? []).filter(
    (entry) => entry.action !== 'created' && entry.action !== 'confirm',
  );
  return parkTimestamp(staffHistory[staffHistory.length - 1]?.createdAt || '');
}

function creatorUpdateNotificationKey(ticket: EnterpriseRepairTicket): string {
  return `updated:${ticket.id}:${creatorUpdateTimestamp(ticket)}`;
}

function isCreatorUpdateUnread(ticket: EnterpriseRepairTicket): boolean {
  const updateTimestamp = creatorUpdateTimestamp(ticket);
  if (!ticket.isCreator || !updateTimestamp) return false;
  if (!ticket.creatorUpdateReadAt) return true;
  return parkTimestamp(ticket.creatorUpdateReadAt) < updateTimestamp;
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

const REQUIRED_SERVICE_REPLY_OPTIONS = ['预约已收到', '订单已收到'] as const;

function serviceReplyOptions(interaction: ServiceInteraction): string[] {
  return [...new Set([...REQUIRED_SERVICE_REPLY_OPTIONS, ...interaction.quickReplies])];
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
  'electric-card': { intro: '填写充电度数即可提交电卡服务申请，系统按 1.2 元/度计算费用，客服会回复办理结果。', quickReplies: ['充电信息已确认', '请到客服中心办理', '充电已完成'], hint: '无需填写电卡编号，园区按企业与房间信息核对。' },
  repair: { intro: '选择或输入报修类别并描述故障，客服回复后会同时转交工程部。', quickReplies: ['远程指导', '已安排上门', '需要补充信息'], hint: '提交后可从园区服务首页的历史记录查看客服回复、工程部处理和最终结果。' },
  'vehicle-visit': { intro: '填写来访日期、具体时间、拜访事由和车辆数量，系统会按数量生成车牌输入框。', quickReplies: ['登记信息已确认', '访客信息需补充', '门岗已收到放行信息'], hint: '无车辆可填写 0；有多辆车时逐辆登记车牌。' },
};

interface ServiceFormField {
  key: string;
  label: string;
  placeholder: string;
  options?: Array<string | { value: string; label: string }>;
  inputType?: 'text' | 'date' | 'time' | 'number' | 'textarea';
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
    {
      key: 'chargingKwh',
      label: '充电度数',
      placeholder: '请输入充电度数（1.2 元/度）',
      inputType: 'number',
      min: 0.1,
    },
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
    { key: 'visitTime', label: '具体来访时间', placeholder: '请选择具体来访时间', inputType: 'time' },
    { key: 'reason', label: '拜访企业及事由', placeholder: '请填写拜访对象和事由', inputType: 'textarea' },
    { key: 'vehicleCount', label: '来访车辆数量', placeholder: '无车辆可填写 0', inputType: 'number', min: 0, max: 20 },
  ],
};

export function serviceFormFields(serviceId: string): ServiceFormField[] {
  const specific = SERVICE_FORM_FIELDS[serviceId] ?? [];
  return [...COMMON_SERVICE_FORM_FIELDS, ...specific.filter((field) => !COMMON_SERVICE_FORM_KEYS.has(field.key))];
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
      id: 'network-phone', icon: IconWrench, name: '网络与固话', desc: '宽带、固话开通与调试',
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
      id: 'electric-card', icon: IconPackage, name: '电卡服务', desc: '按充电度数办理电卡服务',
      prompt: `帮我提交${park}电卡服务申请。公司名称：；房间号：；充电度数：；联系人：；联系电话：`,
      demoSubject: '电卡充电申请 · 100 度',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上提交充电度数、企业房间和联系人。' },
        { role: '专属客服', owner: '林晓', detail: '即时受理并联系企业确认充电信息。' },
        { role: '能源服务专员', owner: '王敏', detail: '核验电卡状态，预约线下办理时间。' },
        { role: '企业用户', owner: '线下办理', detail: '携带电卡至客服中心完成充电手续。' },
        { role: '能源服务专员', owner: '王敏', detail: '写入电量、出具办理结果，流程办结。' },
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
      prompt: `帮我登记${park}车辆与访客申请。公司名称：；房间号：；来访日期：；具体来访时间：；拜访企业及事由：；车辆数量：；各车辆车牌号：；联系人：；联系电话：`,
      demoSubject: '车辆与访客预约登记',
      steps: [
        { role: '企业用户', owner: '演示申请人', detail: '线上提供来访日期、具体时间、拜访事由和按车辆数量生成的车牌信息。' },
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
const PARK_CLOSE_EVENT = 'otto:close-park-services';
export const PARK_STATE_EVENT = 'otto:park-services-state';

export function openParkServices(target?: ParkModuleTarget): void {
  window.dispatchEvent(new CustomEvent(PARK_OPEN_EVENT, { detail: { target } }));
}

/** Close only the Park UI surfaces. Polling and notification subscriptions stay mounted. */
export function closeParkServices(): void {
  window.dispatchEvent(new CustomEvent(PARK_CLOSE_EVENT));
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
    {error ? <div className="otto-park-form__receipt" role="alert">{error}</div> : null}
    {items.length ? <><div className="otto-park-repair__roles">{items.map((item) => <button key={item.id} type="button" className={selected?.id === item.id ? 'is-active' : ''} onClick={() => setSelectedId(item.id)}>{item.submittedAt ? '已提交 · ' : '待填写 · '}{item.title}</button>)}</div>{selected ? <form className="otto-park-survey__form" onSubmit={(event) => { void submit(event); }} aria-label="员工填写满意度调查"><div className="otto-park-receiver__label">提交人：{account?.name || '当前用户'}</div><h3>{selected.title}</h3><p>{selected.body}</p><div className="otto-park-form__grid">{COMMON_SERVICE_FORM_FIELDS.map((field) => <label key={field.key} className="otto-park-form__field">{field.label}<input aria-label={field.label} required value={selected.responseData?.[field.key] ?? identity[field.key as keyof typeof identity]} onChange={(event) => setIdentity((current) => ({ ...current, [field.key]: event.target.value }))} disabled={Boolean(selected.submittedAt)} placeholder={field.placeholder} /></label>)}</div><label>总体满意度<select value={selected.responseData?.score || score} onChange={(event) => setScore(event.target.value)} disabled={Boolean(selected.submittedAt)}><option value="5">5 分 · 非常满意</option><option value="4">4 分 · 满意</option><option value="3">3 分 · 一般</option><option value="2">2 分 · 待改进</option><option value="1">1 分 · 不满意</option></select></label><label>重点关注<input required value={selected.responseData?.focus || focus} onChange={(event) => setFocus(event.target.value)} disabled={Boolean(selected.submittedAt)} placeholder="例如：网络响应、会议室环境" /></label><label>改进建议<textarea required rows={4} value={selected.responseData?.feedback || feedback} onChange={(event) => setFeedback(event.target.value)} disabled={Boolean(selected.submittedAt)} placeholder="请填写具体建议" /></label><button type="submit" className="otto-park-demo__primary" disabled={busy || Boolean(selected.submittedAt)}>{selected.submittedAt ? '已实名提交，不能修改' : busy ? '正在提交…' : '提交问卷'}</button></form> : null}</> : <div className="otto-park-repair__empty">暂无需要填写的满意度调查。</div>}
  </div>;
}

function futureLocalDate(offsetDays = 0): string {
  return parkISODate(new Date(), offsetDays);
}

export function meetingTimeToMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function meetingMinutesToTime(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function isMeetingSlotPast(date: string, slotKey: string, now = new Date()): boolean {
  const today = parkISODate(now);
  if (date < today) return true;
  if (date > today) return false;
  return meetingTimeToMinutes(slotKey) <= parkMinuteOfDay(now);
}

export function effectiveMeetingSlotStatus(
  slot: EnterpriseParkResources['meetingSlots'][number],
  now = new Date(),
): EnterpriseParkResources['meetingSlots'][number]['status'] {
  return slot.status === 'available' && isMeetingSlotPast(slot.date, slot.slotKey, now)
    ? 'closed'
    : slot.status;
}

function serviceOptionValue(option: NonNullable<ServiceFormField['options']>[number]): string {
  return typeof option === 'string' ? option : option.value;
}

function serviceOptionLabel(option: NonNullable<ServiceFormField['options']>[number]): string {
  return typeof option === 'string' ? option : option.label;
}

function serviceFormDisplayValue(field: ServiceFormField, value: string): string {
  const option = field.options?.find((candidate) => serviceOptionValue(candidate) === value);
  return option ? serviceOptionLabel(option) : value;
}

function parkCurrency(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency', currency: 'CNY', maximumFractionDigits: 2,
  }).format(value);
}

function ServiceRequestView({ service, onBack, onComplete, focusTicket }: {
  service: ParkService;
  onBack: () => void;
  onComplete: (ticket?: EnterpriseRepairTicket) => void;
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
  useEffect(() => {
    void refreshResources();
    if (service.id !== 'meeting-room') return undefined;
    const timer = window.setInterval(() => { void refreshResources(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshResources, service.id]);

  const selectedRoom = resources?.meetingRooms.find((room) => room.id === form.roomId) ?? null;
  const visibleSlots = (resources?.meetingSlots.filter((slot) => (
    slot.roomId === form.roomId && slot.date === form.date
  )) ?? [])
    .map((slot) => ({ ...slot, status: effectiveMeetingSlotStatus(slot) }))
    .sort((left, right) => left.slotKey.localeCompare(right.slotKey));
  const selectedMeetingSlots = visibleSlots.filter((slot) => (
    form.startTime && form.endTime
    && slot.slotKey >= form.startTime
    && slot.slotKey < form.endTime
  ));
  const meetingEstimatedAmount = form.startTime && form.endTime && selectedRoom
    ? Math.ceil(
      (meetingTimeToMinutes(form.endTime) - meetingTimeToMinutes(form.startTime)) / (4 * 60),
    ) * selectedRoom.priceHalfDay
    : 0;
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
  const creatorHistoryMode = Boolean(focusTicket?.isCreator);
  const activeTicket = tickets.find((ticket) => ticket.id === selectedId)
    ?? (handlerMode ? assignedTickets[0] : creatorHistoryMode ? ownTickets[0] : null) ?? null;
  const historicalTicket = Boolean(activeTicket && isStaffHistoryTicket(activeTicket));
  const historyEntries = activeTicket ? visibleTicketHistory(activeTicket) : [];

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
    const slotEnd = meetingMinutesToTime(
      meetingTimeToMinutes(slot.slotKey) + MEETING_SLOT_MINUTES,
    );
    setForm((current) => {
      if (
        current.startTime
        && current.endTime
        && slot.slotKey >= current.startTime
        && slot.slotKey < current.endTime
      ) {
        setError(null);
        return {
          ...current,
          slotKey: '',
          startTime: '',
          endTime: '',
          time: '',
        };
      }
      const startTime = !current.startTime || slot.slotKey < current.startTime
        ? slot.slotKey
        : current.startTime;
      const endTime = !current.startTime || slot.slotKey < current.startTime
        ? slotEnd
        : slotEnd;
      const range = visibleSlots.filter((candidate) => (
        candidate.slotKey >= startTime && candidate.slotKey < endTime
      ));
      const expected = (
        meetingTimeToMinutes(endTime) - meetingTimeToMinutes(startTime)
      ) / MEETING_SLOT_MINUTES;
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
        if (!normalized.date || normalized.date < futureLocalDate()) throw new Error('会议室不能预约过去日期');
        if (!normalized.startTime || !normalized.endTime) throw new Error('请在时间轴上选择连续的绿色时段');
        if (!normalized.attendees || attendeeError) throw new Error(attendeeError || '请填写参会人数');
      }
      const displayForm = Object.fromEntries(fields.map((field) => [
        field.key,
        serviceFormDisplayValue(field, normalized[field.key] || ''),
      ]));
      const primary = normalized.roomName || displayForm.area || displayForm.applicationType
        || displayForm.businessType
        || (service.id === 'electric-card' && normalized.chargingKwh ? `${normalized.chargingKwh} 度` : '')
        || displayForm.roomNumber || normalized.date || displayForm.category || service.name;
      const description = service.id === 'repair'
        ? normalized.issue
        : [
          ...(service.id === 'meeting-room'
            ? [
              `会议室：${normalized.roomName}`,
              `使用日期：${normalized.date}`,
              `使用时间：${normalized.time}`,
              `计费标准：${normalized.priceHalfDay} 元/半天，不足半天按半天计`,
              `本次预计金额：${meetingEstimatedAmount} 元`,
            ]
            : []),
          ...(service.id === 'electric-card'
            ? [
              `充电度数：${normalized.chargingKwh} 度`,
              '计费标准：1.2 元/度',
              `预计金额：${(Number(normalized.chargingKwh) * 1.2).toFixed(2)} 元`,
            ]
            : []),
          ...fields
            .filter((field) => !(service.id === 'electric-card' && field.key === 'chargingKwh'))
            .map((field) => `${field.label}：${displayForm[field.key] || ''}`),
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
      onComplete(next);
    } catch (cause) {
      setError(errorMessage(cause));
      if (service.id === 'meeting-room') await refreshResources();
    } finally {
      setBusy(false);
    }
  };

  const action = async (
    ticket: EnterpriseRepairTicket,
    actionName: 'respond' | 'accept' | 'complete' | 'confirm' | 'respond_and_transfer',
    extra: {
      responseType?: string;
      responseText?: string;
      transferDepartment?: string;
      transferNote?: string;
    } = {},
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.otto.enterpriseTicketAction(ticket.id, {
        action: actionName,
        ...(['respond', 'respond_and_transfer'].includes(actionName)
          ? { responseType: response.type, responseText: response.text }
          : {}),
        ...extra,
      });
      replaceTicket(next);
      if (['respond', 'respond_and_transfer'].includes(actionName)) setResponse({ type: '', text: '' });
      if (['respond', 'respond_and_transfer', 'complete', 'confirm'].includes(actionName)) {
        onComplete(next);
      }
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
    {error ? <div className="otto-park-form__receipt" role="alert">{error}</div> : null}

    {creatorHistoryMode && activeTicket?.isCreator ? <div className="otto-park-technician-form">
      <div className="otto-park-request-summary">
        <div><span>申请编号</span><strong>{ticketApplicationNumber(activeTicket)}</strong></div>
        <div><span>服务类型</span><strong>{service.name}</strong></div>
        <div><span>状态</span><strong>{activeTicket.status}</strong></div>
        <div><span>办理回复</span><strong>{activeTicket.responseType || '等待受理'}</strong></div>
        <div><span>回复内容补充</span><strong>{activeTicket.responseText || '暂无'}</strong></div>
      </div>
      <section className="otto-park-ticket-history" aria-label="我的园区服务处理历史">
        <div className="otto-park-ticket-history__head"><strong>处理记录</strong><span>{historyEntries.length} 条 · 按时间顺序</span></div>
        <ol>{historyEntries.map((entry) => <li key={entry.id}>
          <span className="otto-park-ticket-history__marker" aria-hidden />
          <div>
            <div className="otto-park-ticket-history__meta">
              <strong>{HISTORY_ACTION_LABELS[entry.action]}</strong>
              <time dateTime={entry.createdAt}>{formatParkTimestamp(entry.createdAt)}</time>
            </div>
            <p>{entry.actor?.name || '园区工作人员'} · 状态：{entry.statusAfter}</p>
            {entry.responseType ? <p><b>{entry.responseType}</b>{entry.responseText ? `：${entry.responseText}` : ''}</p> : null}
          </div>
        </li>)}</ol>
      </section>
      {activeTicket.status === '待验收' ? <button type="button" className="otto-park-demo__primary" disabled={busy} onClick={() => { void action(activeTicket, 'confirm'); }}>确认办理完成</button> : null}
    </div> : !handlerMode ? (
      <form className="otto-park-request-form" onSubmit={(event) => { void submitTicket(event); }} aria-label={`${service.name}申请表`}>
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
                <span>{form.startTime && form.endTime
                  ? `已选择 ${form.startTime}–${form.endTime}；${selectedRoom?.priceHalfDay} 元/半天，不足半天按半天计；本次预计 ${meetingEstimatedAmount} 元；再次点击黄色时段可取消`
                  : '点击绿色格子选择开始时间，再点击后续绿色格子延长时间'}</span>
                {form.startTime ? <button type="button" onClick={() => setForm((current) => ({ ...current, slotKey: '', startTime: '', endTime: '', time: '' }))}>重新选择</button> : null}
              </div>
            </> : <p>该日期暂时没有园区发布的可预约时段</p>}
            <div className="otto-park-meeting-legend">
              <span className="is-available">绿色 · 可预约</span>
              <span className="is-booked">红色 · 已预约</span>
              <span className="is-selected">黄色 · 已选择</span>
              <span className="is-closed">灰色 · 已过期或未开放</span>
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
                step={field.inputType === 'number'
                  ? service.id === 'electric-card' && field.key === 'chargingKwh' ? 0.1 : 1
                  : undefined}
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
    ) : <div className="otto-park-technician-form">
      {assignedTickets.length ? <>
        <div className="otto-park-repair__roles">{assignedTickets.map((ticket) => <button key={ticket.id} type="button" className={activeTicket?.id === ticket.id ? 'is-active' : ''} onClick={() => { void openAssigned(ticket); }}>{ticket.title} · {ticket.status}{!ticket.readAt ? ' · 新' : ''}</button>)}</div>
        {activeTicket?.isRecipient ? <>
          {historicalTicket ? <div className="otto-park-history-readonly" role="status">
            <strong>历史记录只读</strong>
            <span>该服务已进入验收或完成阶段，申请内容和每次处理结果均已留存。</span>
          </div> : null}
          <div className="otto-park-request-summary">
            <div><span>申请编号</span><strong>{ticketApplicationNumber(activeTicket)}</strong></div>
            <div className="is-wide"><span>{service.id === 'meeting-room' ? '会议内容' : '申请内容'}</span><strong>{activeTicket.description}</strong></div>
            <div><span>最终状态</span><strong>{activeTicket.status}</strong></div>
            <div><span>最新办理结果</span><strong>{activeTicket.responseType || '暂无办理回复'}</strong></div>
            <div className="is-wide"><span>回复内容补充</span><strong>{activeTicket.responseText || '暂无'}</strong></div>
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
                <datalist id={`otto-park-response-${service.id}`}>{serviceReplyOptions(interaction).map((reply) => <option key={reply} value={reply} />)}</datalist>
              </label>
              <label className="otto-park-form__field">回复内容补充
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
            </form> : <form className="otto-park-response-form" onSubmit={(event) => {
              event.preventDefault();
              void action(activeTicket, 'respond_and_transfer', {
                transferDepartment: '工程部',
                transferNote: '请工程部接手处理该物业报修，并在完成后记录工作结果。',
              });
            }} aria-label="物业报修回复并转交工程部">
                <label className="otto-park-form__field">处理方式
                  <input required list="otto-park-repair-response-options" value={response.type} onChange={(event) => setResponse((current) => ({ ...current, type: event.target.value }))} placeholder="选择或输入处理方式" />
                  <datalist id="otto-park-repair-response-options">{serviceReplyOptions(interaction).map((reply) => <option key={reply} value={reply} />)}</datalist>
                </label>
                <label className="otto-park-form__field">回复内容补充
                  <textarea required rows={4} value={response.text} onChange={(event) => setResponse((current) => ({ ...current, text: event.target.value }))} placeholder="说明处理建议、预约时间或需要补充的信息" />
                </label>
                <div className="otto-park-request-summary">
                  <div><span>转交部门</span><strong>工程部</strong></div>
                  <div><span>处理步骤</span><strong>回复申请人并同步转交</strong></div>
                </div>
                <button type="submit" className="otto-park-demo__primary" disabled={busy || !response.type.trim() || !response.text.trim()}>回复并转交工程部</button>
              </form>}
          </> : null}
        </> : null}
      </> : <div className="otto-park-repair__empty">当前没有分配给你的待办。</div>}
    </div>}
  </div>;
}

function ServiceDemo({ service, onBack, onComplete, focusTicket }: { service: ParkService; onBack: () => void; onComplete: (ticket?: EnterpriseRepairTicket) => void; focusTicket: EnterpriseRepairTicket | null }): React.JSX.Element {
  if (service.id === 'announcement') return <AnnouncementView onBack={onBack} />;
  if (service.id === 'satisfaction') return <SatisfactionView onBack={onBack} />;
  return <ServiceRequestView service={service} onBack={onBack} onComplete={onComplete} focusTicket={focusTicket} />;
}

interface ParkServiceWindowState {
  id: string;
  service: ParkService;
  focusTicket: EnterpriseRepairTicket | null;
  initialPosition: { x: number; y: number };
}

function ParkServiceWindow({
  entry,
  stackOrder,
  dockIndex,
  onActivate,
  onBack,
  onClose,
  onComplete,
}: {
  entry: ParkServiceWindowState;
  stackOrder: number;
  dockIndex: number;
  onActivate: (id: string) => void;
  onBack: (id: string) => void;
  onClose: (id: string) => void;
  onComplete: (id: string, ticket?: EnterpriseRepairTicket) => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<'normal' | 'minimized' | 'maximized'>('normal');
  const [position, setPosition] = useState(entry.initialPosition);
  const drag = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } | null>(null);
  const uid = useId();

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (mode !== 'normal' || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    const dialog = event.currentTarget.closest('.otto-park-dialog');
    const bounds = dialog?.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startX: position.x,
      startY: position.y,
      minX: position.x - (bounds?.left ?? 0),
      maxX: position.x + window.innerWidth - 160 - (bounds?.left ?? 0),
      minY: position.y - (bounds?.top ?? 0),
      maxY: position.y + window.innerHeight - 48 - (bounds?.top ?? 0),
    };
    onActivate(entry.id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setPosition({
      x: Math.max(active.minX, Math.min(active.startX + event.clientX - active.originX, active.maxX)),
      y: Math.max(active.minY, Math.min(active.startY + event.clientY - active.originY, active.maxY)),
    });
  };
  const stopDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  if (mode === 'minimized') {
    return <button
      type="button"
      className="otto-park-window-minimized otto-park-window-minimized--stacked"
      style={{ bottom: 18 + dockIndex * 50, zIndex: 121 + stackOrder }}
      onClick={() => {
        onActivate(entry.id);
        setMode('normal');
      }}
      aria-label={`还原${entry.service.name}窗口`}
    >
      <IconBuilding size={17} />
      <span>{entry.service.name}</span>
    </button>;
  }

  return <div
    className={`otto-park-overlay otto-park-overlay--service-window ${mode === 'maximized' ? 'is-maximized' : ''}`}
    style={{ zIndex: 90 + stackOrder }}
    onPointerDown={() => onActivate(entry.id)}
  >
    <div
      className={`otto-park-dialog ${mode === 'maximized' ? 'is-maximized' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${uid}-title`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose(entry.id);
        }
      }}
      style={mode === 'normal' && (position.x || position.y)
        ? { transform: `translate(${position.x}px, ${position.y}px)` }
        : undefined}
    >
      <div
        className="otto-park-dialog__head"
        onPointerDown={startDrag}
        onPointerMove={move}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <span className="otto-park-dialog__headicon" aria-hidden><IconBuilding size={19} /></span>
        <div className="otto-park-dialog__headtext">
          <h2 className="otto-park-dialog__title" id={`${uid}-title`}>{entry.service.name}</h2>
          <div className="otto-park-dialog__subtitle">可与其他园区服务窗口同时办理，表单进度互不影响。</div>
        </div>
        <div className="otto-park-dialog__window-controls">
          <button type="button" onClick={() => setMode('minimized')} aria-label={`最小化${entry.service.name}窗口`}>—</button>
          <button
            type="button"
            onClick={() => {
              setMode((current) => current === 'maximized' ? 'normal' : 'maximized');
              drag.current = null;
            }}
            aria-label={mode === 'maximized' ? `还原${entry.service.name}窗口` : `最大化${entry.service.name}窗口`}
          >{mode === 'maximized' ? '❐' : '□'}</button>
          <button type="button" className="otto-park-dialog__close" onClick={() => onClose(entry.id)} aria-label={`关闭${entry.service.name}窗口`}><IconClose size={14} /></button>
        </div>
      </div>
      <ServiceDemo
        service={entry.service}
        focusTicket={entry.focusTicket}
        onBack={() => onBack(entry.id)}
        onComplete={(ticket) => onComplete(entry.id, ticket)}
      />
    </div>
  </div>;
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
  const [serviceWindows, setServiceWindows] = useState<ParkServiceWindowState[]>([]);
  const [backgroundTickets, setBackgroundTickets] = useState<EnterpriseRepairTicket[]>([]);
  const [backgroundTicketSummaryCount, setBackgroundTicketSummaryCount] = useState(0);
  const [backgroundPublication, setBackgroundPublication] = useState<EnterpriseParkPublication | null>(null);
  const [focusTicket, setFocusTicket] = useState<EnterpriseRepairTicket | null>(null);
  const [assignedTasks, setAssignedTasks] = useState<EnterpriseRepairTicket[]>([]);
  const [assignedHistory, setAssignedHistory] = useState<EnterpriseRepairTicket[]>([]);
  const [ownHistory, setOwnHistory] = useState<EnterpriseRepairTicket[]>([]);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyCategory, setHistoryCategory] = useState('all');
  const [historySort, setHistorySort] = useState<'desc' | 'asc'>('desc');
  const [pendingNotificationSessionId, setPendingNotificationSessionId] = useState<string | null>(null);
  const [pendingLandingTarget, setPendingLandingTarget] = useState<
    'overview' | 'staff-tasks' | 'my-applications' | null
  >(null);
  const [windowMode, setWindowMode] = useState<'normal' | 'minimized' | 'maximized'>('normal');
  const [windowPosition, setWindowPosition] = useState({ x: 0, y: 0 });
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const statisticsRef = useRef<HTMLElement>(null);
  const staffTasksRef = useRef<HTMLElement>(null);
  const applicationsRef = useRef<HTMLElement>(null);
  const focusedLandingElementRef = useRef<HTMLElement | null>(null);
  const windowDrag = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  } | null>(null);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent(PARK_STATE_EVENT, {
      detail: { open: open || serviceWindows.length > 0 },
    }));
  }, [open, serviceWindows.length]);
  const notifiedTicketKeys = useRef(new Set<string>());
  const ticketPollIdentity = useRef<string | null>(null);
  const ticketPollInitialized = useRef(false);
  const notifiedPublicationKeys = useRef(new Set<string>());
  const uid = useId();
  const titleId = `${uid}-title`;

  const openServiceWindow = useCallback((
    service: ParkService,
    ticket: EnterpriseRepairTicket | null = null,
  ): void => {
    const id = ticket ? `ticket:${ticket.id}` : `service:${service.id}`;
    setServiceWindows((current) => {
      const existing = current.find((entry) => entry.id === id);
      const remaining = current.filter((entry) => entry.id !== id);
      if (existing) {
        return [...remaining, { ...existing, service, focusTicket: ticket ?? existing.focusTicket }];
      }
      const offset = Math.min(current.length, 5) * 26;
      return [...current, {
        id,
        service,
        focusTicket: ticket,
        initialPosition: { x: offset, y: offset },
      }];
    });
    setOpen(false);
  }, []);

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
    if (open && !selected && !pendingLandingTarget) firstItemRef.current?.focus();
  }, [open, pendingLandingTarget, selected]);

  useLayoutEffect(() => {
    if (!open || selected || !pendingLandingTarget) return;
    const target = pendingLandingTarget === 'overview'
      ? statisticsRef.current
      : pendingLandingTarget === 'staff-tasks'
        ? staffTasksRef.current
        : applicationsRef.current;
    if (!target?.isConnected || focusedLandingElementRef.current === target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: 'nearest' });
    focusedLandingElementRef.current = target;
  }, [assignedTasks.length, open, parkStatistics, pendingLandingTarget, selected]);

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
    const showParkSession = (
      sessionId?: string,
      landingTarget?: 'overview' | 'staff-tasks' | 'my-applications',
    ): void => {
      setSelected(null);
      setFocusTicket(null);
      setPendingNotificationSessionId(sessionId?.startsWith('park:') ? sessionId : null);
      focusedLandingElementRef.current = null;
      setPendingLandingTarget(landingTarget ?? null);
      setWindowMode('normal');
      setOpen(true);
    };
    const onOpen = (event: Event): void => {
      const target = event instanceof CustomEvent && typeof event.detail?.target === 'string'
        ? event.detail.target as ParkModuleTarget
        : undefined;
      const sessionId = event instanceof CustomEvent && typeof event.detail?.sessionId === 'string'
        ? event.detail.sessionId
        : undefined;
      if (target && target !== 'overview' && target !== 'staff-tasks' && target !== 'my-applications') {
        const service = services.find((item) => item.id === target);
        if (service) {
          setSelected(null);
          setFocusTicket(null);
          setPendingNotificationSessionId(null);
          focusedLandingElementRef.current = null;
          setPendingLandingTarget(null);
          setWindowMode('normal');
          openServiceWindow(service);
          return;
        }
      }
      showParkSession(
        sessionId,
        target === 'overview' || target === 'staff-tasks' || target === 'my-applications'
          ? target
          : undefined,
      );
    };
    const onClose = (): void => {
      setSelected(null);
      setFocusTicket(null);
      setPendingNotificationSessionId(null);
      focusedLandingElementRef.current = null;
      setPendingLandingTarget(null);
      setWindowMode('normal');
      setWindowPosition({ x: 0, y: 0 });
      windowDrag.current = null;
      setOpen(false);
      setServiceWindows([]);
    };
    const unsubscribeNotification = window.otto.onNotificationSessionOpen?.((sessionId) => {
      if (sessionId.startsWith('park:')) showParkSession(sessionId);
    }) ?? (() => {});
    window.addEventListener(PARK_OPEN_EVENT, onOpen);
    window.addEventListener(PARK_CLOSE_EVENT, onClose);
    return () => {
      unsubscribeNotification();
      window.removeEventListener(PARK_OPEN_EVENT, onOpen);
      window.removeEventListener(PARK_CLOSE_EVENT, onClose);
    };
  }, [openServiceWindow, parkEnabled, services]);

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
          setOwnHistory([]);
          setBackgroundTickets([]);
          setBackgroundTicketSummaryCount(0);
          setServiceWindows([]);
          notifiedTicketKeys.current.clear();
          ticketPollIdentity.current = null;
          ticketPollInitialized.current = false;
          return;
        }
        const identity = `${session.account.organizationId}:${session.account.id}`;
        if (ticketPollIdentity.current !== identity) {
          const previousIdentity = ticketPollIdentity.current;
          ticketPollIdentity.current = identity;
          ticketPollInitialized.current = false;
          notifiedTicketKeys.current.clear();
          setAssignedHistory([]);
          setOwnHistory([]);
          setBackgroundTickets([]);
          setBackgroundTicketSummaryCount(0);
          // Initial identity hydration must not close a form the user opened
          // while the first ticket poll was still in flight. Only a real
          // account or organization switch invalidates open service windows.
          if (previousIdentity !== null) setServiceWindows([]);
        }
        const tickets = await window.otto.enterpriseTicketList();
        if (cancelled) return;
        const actionableTasks = tickets.filter(isActionableStaffTicket);
        const completedHistory = tickets.filter(isStaffHistoryTicket);
        const creatorHistory = tickets
          .filter((ticket) => ticket.isCreator)
          .sort((left, right) => ticketLatestTimestamp(right) - ticketLatestTimestamp(left));
        const latestTickets = new Map(tickets.map((ticket) => [ticket.id, ticket]));
        setAssignedTasks(actionableTasks);
        setAssignedHistory(completedHistory);
        setOwnHistory(creatorHistory);
        setBackgroundTickets((current) => current
          .map((ticket) => latestTickets.get(ticket.id) ?? ticket)
          .filter((ticket) => (
            ticket.isRecipient ? !ticket.readAt : isCreatorUpdateUnread(ticket)
          )));
        setBackgroundTicketSummaryCount((current) => current > 0 ? actionableTasks.length : 0);

        const assignedCandidates = actionableTasks.filter((ticket) => (
          !ticket.readAt && !notifiedTicketKeys.current.has(assignedNotificationKey(ticket))
        ));
        const creatorCandidates = tickets.filter((ticket) => (
          isCreatorUpdateUnread(ticket)
          && !notifiedTicketKeys.current.has(creatorUpdateNotificationKey(ticket))
        ));
        const settledRecipientCandidates = tickets.filter((ticket) => (
          ticket.isRecipient
          && !isActionableStaffTicket(ticket)
          && !ticket.readAt
          && !notifiedTicketKeys.current.has(assignedNotificationKey(ticket))
        ));

        if (!ticketPollInitialized.current) {
          ticketPollInitialized.current = true;
          for (const ticket of assignedCandidates) notifiedTicketKeys.current.add(assignedNotificationKey(ticket));
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
              persistent: true,
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
            persistent: true,
          }, title, body);
        } else if (assignedCandidates.length === 1) {
          const candidate = assignedCandidates[0];
          notifiedTicketKeys.current.add(assignedNotificationKey(candidate));
          const title = 'Otto 待处理提醒 · 园区服务';
          const body = `申请单 ${ticketApplicationNumber(candidate)} · ${candidate.title}`;
          showParkNotification({
            messageId: `park-ticket:${candidate.id}:${candidate.updatedAt}`,
            sessionId: `park:ticket:${candidate.id}`,
            source: 'park',
            title,
            sender: candidate.creator.name,
            preview: body,
            persistent: true,
          }, title, body);
          setBackgroundTickets((current) => [
            candidate,
            ...current.filter((ticket) => ticket.id !== candidate.id),
          ]);
        }

        for (const candidate of [...creatorCandidates, ...settledRecipientCandidates]) {
          const key = candidate.isCreator
            ? creatorUpdateNotificationKey(candidate)
            : assignedNotificationKey(candidate);
          if (notifiedTicketKeys.current.has(key)) continue;
          notifiedTicketKeys.current.add(key);
          const title = candidate.isCreator
            ? 'Otto 园区服务进度提醒'
            : 'Otto 园区任务状态提醒';
          const body = `申请单 ${ticketApplicationNumber(candidate)} · ${candidate.title} · ${candidate.responseType || candidate.status}`;
          showParkNotification({
            messageId: `park-ticket:${candidate.id}:${candidate.updatedAt}`,
            sessionId: `park:ticket:${candidate.id}`,
            source: 'park',
            title,
            preview: body,
            persistent: true,
          }, title, body);
          setBackgroundTickets((current) => [
            candidate,
            ...current.filter((ticket) => ticket.id !== candidate.id),
          ]);
        }
      } catch {
        // 未登录、服务器暂不可达时安静重试；报修页打开后会显示具体错误。
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [parkEnabled]);

  const close = (): void => {
    setSelected(null);
    setFocusTicket(null);
    focusedLandingElementRef.current = null;
    setPendingLandingTarget(null);
    setOpen(false);
    setWindowMode('normal');
    setWindowPosition({ x: 0, y: 0 });
    windowDrag.current = null;
  };
  const completeService = (ticket?: EnterpriseRepairTicket): void => {
    if (ticket?.isCreator) {
      setOwnHistory((current) => [
        ticket,
        ...current.filter((item) => item.id !== ticket.id),
      ]);
    }
    close();
  };
  const closeServiceWindow = useCallback((id: string): void => {
    setServiceWindows((current) => current.filter((entry) => entry.id !== id));
  }, []);
  const activateServiceWindow = useCallback((id: string): void => {
    setServiceWindows((current) => {
      const active = current.find((entry) => entry.id === id);
      if (!active || current[current.length - 1]?.id === id) return current;
      return [...current.filter((entry) => entry.id !== id), active];
    });
  }, []);
  const returnFromServiceWindow = useCallback((id: string): void => {
    closeServiceWindow(id);
    setOpen(true);
  }, [closeServiceWindow]);
  const completeServiceWindow = useCallback((
    id: string,
    ticket?: EnterpriseRepairTicket,
  ): void => {
    if (ticket?.isCreator) {
      setOwnHistory((current) => [
        ticket,
        ...current.filter((item) => item.id !== ticket.id),
      ]);
    }
    closeServiceWindow(id);
  }, [closeServiceWindow]);
  const startWindowDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (windowMode !== 'normal' || event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button')) return;
    const dialog = event.currentTarget.closest('.otto-park-dialog');
    const bounds = dialog?.getBoundingClientRect();
    windowDrag.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startX: windowPosition.x,
      startY: windowPosition.y,
      minX: windowPosition.x - (bounds?.left ?? 0),
      maxX: windowPosition.x + window.innerWidth - 160 - (bounds?.left ?? 0),
      minY: windowPosition.y - (bounds?.top ?? 0),
      maxY: windowPosition.y + window.innerHeight - 48 - (bounds?.top ?? 0),
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveWindow = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = windowDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextX = drag.startX + event.clientX - drag.originX;
    const nextY = drag.startY + event.clientY - drag.originY;
    setWindowPosition({
      x: Math.max(drag.minX, Math.min(nextX, drag.maxX)),
      y: Math.max(drag.minY, Math.min(nextY, drag.maxY)),
    });
  };
  const stopWindowDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (windowDrag.current?.pointerId !== event.pointerId) return;
    windowDrag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const pick = (service: ParkService): void => {
    openServiceWindow(service);
  };

  const openTicket = useCallback((ticket: EnterpriseRepairTicket): void => {
    const service = services.find((item) => item.id === (ticket.serviceId || 'repair'))
      ?? services.find((item) => item.id === 'repair');
    if (service) {
      openServiceWindow(service, ticket);
    }
  }, [openServiceWindow, services]);

  const openOwnHistoryTicket = useCallback((ticket: EnterpriseRepairTicket): void => {
    openTicket(ticket);
    setBackgroundTickets((current) => current.filter((item) => item.id !== ticket.id));
    void window.otto.notificationMarkRead?.(`park:ticket:${ticket.id}`).catch(() => undefined);
    void window.otto.enterpriseTicketRead(ticket.id).then((viewed) => {
      const applyUpdate = (current: EnterpriseRepairTicket[]): EnterpriseRepairTicket[] => current.map(
        (item) => item.id === viewed.id ? viewed : item,
      );
      setOwnHistory(applyUpdate);
      setBackgroundTickets(applyUpdate);
      setFocusTicket((current) => current?.id === viewed.id ? viewed : current);
      setServiceWindows((current) => current.map((entry) => (
        entry.focusTicket?.id === viewed.id ? { ...entry, focusTicket: viewed } : entry
      )));
    }).catch(() => undefined);
  }, [openTicket]);

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
      setServiceWindows((current) => current.map((entry) => {
        const updated = entry.focusTicket ? updates.get(entry.focusTicket.id) : undefined;
        return updated ? { ...entry, focusTicket: updated } : entry;
      }));
    });
  }, []);

  const openAssignedTicket = useCallback((ticket: EnterpriseRepairTicket): void => {
    openTicket(ticket);
    markAssignedTicketsViewed([ticket]);
    void window.otto.notificationMarkRead?.(`park:ticket:${ticket.id}`).catch(() => undefined);
  }, [markAssignedTicketsViewed, openTicket]);

  const openBackgroundTicket = (ticket: EnterpriseRepairTicket): void => {
    if (ticket.isCreator) openOwnHistoryTicket(ticket);
    else openAssignedTicket(ticket);
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
      ?? ownHistory.find((item) => item.id === ticketId)
      ?? backgroundTickets.find((item) => item.id === ticketId);
    if (!ticket) return;
    if (ticket.isCreator) openOwnHistoryTicket(ticket);
    else openAssignedTicket(ticket);
    setPendingNotificationSessionId(null);
    setBackgroundTickets((current) => current.filter((item) => item.id !== ticket.id));
    void window.otto.notificationMarkRead?.(sessionId).catch(() => undefined);
  }, [assignedTasks, backgroundTickets, markAssignedTicketsViewed, openAssignedTicket, openOwnHistoryTicket, ownHistory, pendingNotificationSessionId]);

  const openBackgroundPublication = (): void => {
    const serviceId = backgroundPublication?.kind;
    const service = services.find((item) => item.id === serviceId);
    if (service) {
      openServiceWindow(service);
    }
    setBackgroundPublication(null);
  };

  if (parkEnabled !== true) return <></>;

  return <>
  {open && windowMode === 'minimized' ? (
    <button
      type="button"
      className="otto-park-window-minimized"
      onClick={() => setWindowMode('normal')}
      aria-label="还原园区服务窗口"
    >
      <IconBuilding size={17} />
      <span>{selected ? selected.name : brand}</span>
    </button>
  ) : open ? (
    <div
      className={`otto-park-overlay ${windowMode === 'maximized' ? 'is-maximized' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
    >
      <div
        className={`otto-park-dialog ${windowMode === 'maximized' ? 'is-maximized' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        style={windowMode === 'normal' && (windowPosition.x || windowPosition.y)
          ? { transform: `translate(${windowPosition.x}px, ${windowPosition.y}px)` }
          : undefined}
      >
        <div
          className="otto-park-dialog__head"
          onPointerDown={startWindowDrag}
          onPointerMove={moveWindow}
          onPointerUp={stopWindowDrag}
          onPointerCancel={stopWindowDrag}
        >
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
          <div className="otto-park-dialog__window-controls">
            <button type="button" onClick={() => setWindowMode('minimized')} aria-label="最小化园区服务窗口">—</button>
            <button
              type="button"
              onClick={() => {
                setWindowMode((current) => current === 'maximized' ? 'normal' : 'maximized');
                windowDrag.current = null;
              }}
              aria-label={windowMode === 'maximized' ? '还原园区服务窗口' : '最大化园区服务窗口'}
            >{windowMode === 'maximized' ? '❐' : '□'}</button>
            <button type="button" className="otto-park-dialog__close" onClick={close} aria-label="关闭"><IconClose size={14} /></button>
          </div>
        </div>
        {selected ? (
          <ServiceDemo service={selected} onBack={() => { setSelected(null); setFocusTicket(null); }} onComplete={completeService} focusTicket={focusTicket} />
        ) : (
          <div className="otto-park-dialog__landing">
            {parkAdminOrganization ? <section
              ref={statisticsRef}
              className="otto-park-statistics"
              aria-label="产业园服务统计"
              tabIndex={-1}
            >
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
            <div className="otto-park-home-layout">
              <section className="otto-park-home-services" aria-label="园区服务列表">
                <div className="otto-park-home-panel__head">
                  <strong>园区服务</strong>
                  <span>选择左侧服务开始办理</span>
                </div>
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
              </section>
              <aside className="otto-park-home-activity" aria-label="园区待办与历史">
                {assignedTasks.length || assignedHistory.length || pendingLandingTarget === 'staff-tasks' ? <div className="otto-park-staff-workspace">
                  {assignedTasks.length || pendingLandingTarget === 'staff-tasks' ? <section
                    ref={staffTasksRef}
                    className="otto-park-staff-tasks"
                    aria-label="我的园区待办"
                    tabIndex={-1}
                  >
                    <div className="otto-park-staff-panel__head"><strong>我的园区待办</strong><span>{assignedTasks.length} 项待处理 · 仅工作人员可见</span></div>
                    <div className="otto-park-staff-tasks__items">{assignedTasks.length
                      ? assignedTasks.map((ticket) => <button key={ticket.id} type="button" onClick={() => openAssignedTicket(ticket)} aria-label={`打开工作人员待办：${ticket.title}`}><span>{ticket.title}</span><em>{ticket.status} {!ticket.readAt ? '· 新' : ''}</em></button>)
                      : <div className="otto-park-staff-history__empty">当前没有待处理的园区任务。</div>}</div>
                  </section> : null}
                  {assignedHistory.length ? <section className="otto-park-staff-history" aria-label="我的园区服务历史记录">
                    <div className="otto-park-staff-panel__head"><strong>工作人员办理历史</strong><span>{visibleAssignedHistory.length} / {assignedHistory.length} 条 · 仅工作人员可见</span></div>
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
                <section
                  ref={applicationsRef}
                  className="otto-park-staff-history otto-park-own-history"
                  aria-label="我的园区申请历史记录"
                  tabIndex={-1}
                >
                  <div className="otto-park-staff-panel__head"><strong>我的申请历史</strong><span>{ownHistory.length} 条 · 点击查看完整处理记录</span></div>
                  <div className="otto-park-staff-history__items">
                    {ownHistory.length ? ownHistory.map((ticket) => {
                      const serviceName = historyCategoryOptions.find((service) => service.id === ticket.serviceId)?.name || ticket.serviceId;
                      return <button key={ticket.id} type="button" onClick={() => openOwnHistoryTicket(ticket)} aria-label={`打开我的申请历史：${ticket.title}`}>
                        <span><b>{serviceName}</b><em>{ticket.status}</em></span>
                        <strong>{ticketApplicationNumber(ticket)} · {ticket.title}</strong>
                        <small>{formatParkTimestamp(ticket.updatedAt || ticket.createdAt)}</small>
                        <p>{ticket.responseType || '等待受理'}{ticket.responseText ? `：${ticket.responseText}` : ''}</p>
                      </button>;
                    }) : <div className="otto-park-staff-history__empty">暂无申请历史；提交服务后可在这里查看。</div>}
                  </div>
                </section>
              </aside>
            </div>
          </div>
        )}
      </div>
    </div>
  ) : null}
  {serviceWindows.map((entry, index) => (
    <ParkServiceWindow
      key={entry.id}
      entry={entry}
      stackOrder={index}
      dockIndex={index}
      onActivate={activateServiceWindow}
      onBack={returnFromServiceWindow}
      onClose={closeServiceWindow}
      onComplete={completeServiceWindow}
    />
  ))}
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
