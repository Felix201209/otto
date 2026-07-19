/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

/**
 * Otto fixed Agent catalog.
 *
 * The product-level decision is to expose one stable set of 9 Agents:
 * one enterprise work Agent plus eight base experts. Department-specific,
 * CEO-only, split meeting, and legacy kickoff-based expert definitions were
 * removed from this runtime catalog to avoid multiple conflicting counts.
 */

import type { GeneratedIconName } from '../components/GeneratedIcon.js';

export const DEPARTMENT_IDS = [] as const;
export type DepartmentId =
  | 'ceo-office'
  | 'product-rd'
  | 'marketing'
  | 'sales-customer-success'
  | 'finance'
  | 'hr-admin';
export type AgentProfileScope = 'base' | 'department' | 'personal';

export const DEPARTMENT_LABELS: Readonly<Partial<Record<DepartmentId, string>>> = {};

export interface AgentProfile {
  /** Stable id used by session metadata, React keys, and telemetry. */
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly scope: AgentProfileScope;
  readonly department: DepartmentId | null;
  readonly skills: readonly string[];
  /** System-layer profile prompt. Never send this as a user kickoff message. */
  readonly systemPrompt: string;
  readonly icon?: GeneratedIconName;
  readonly accent?: string;
}

export const ENTERPRISE_WORK_PROFILE: AgentProfile = {
  id: 'otto-enterprise-work',
  name: '企业工作 Agent',
  tagline: '按当前部门和职位完成日常工作',
  scope: 'base',
  department: null,
  skills: [],
  systemPrompt:
    '你是企业员工的基础工作 Agent。围绕当前部门和职位完成文档、调研、分析、会议与日程工作，按需加载企业允许的 Skill；只读取当前身份获授权的数据，不展示无权访问的成员或部门信息，不发起多 Agent 交流。涉及外发、修改企业数据或影响他人的操作必须先确认。',
};

/** Backward-compatible alias. The fixed catalog no longer exposes a separate personal Otto Agent. */
export const PERSONAL_OTTO_PROFILE = ENTERPRISE_WORK_PROFILE;

/** Backward-compatible alias. The fixed catalog uses the enterprise work Agent for every role. */
export const ENTERPRISE_CEO_PROFILE = ENTERPRISE_WORK_PROFILE;

function baseExpertProfile(
  spec: Omit<AgentProfile, 'scope' | 'department'>,
): AgentProfile {
  return { ...spec, scope: 'base', department: null };
}

/** The eight fixed base experts. */
export const COMMON_EXPERT_PROFILES: readonly AgentProfile[] = [
  baseExpertProfile({
    id: 'ppt',
    name: 'PPT 创作专家',
    tagline: '从主题到成稿：结构化叙事幻灯片',
    icon: 'expert-presentation',
    accent: '#38bdf8',
    skills: ['ppt-creator'],
    systemPrompt:
      '你是审美总监级 PPT 创作专家，不是套模板的文档生成器。开始前必须先加载内置 ppt-creator Skill，并严格按 Skill 的当前方法执行；确认核心结论、受众、时长、场景和品牌素材后，为本次主题确定唯一视觉母题与叙事节奏。以 HTML/CSS/SVG 为主视觉画布，使用 Playwright 或本机浏览器逐页渲染，结合 Node.js + PptxGenJS 或 python-pptx 完成真实可交付的 PPTX；Python 只用于图表、形状或排版增强，不得退化成固定模板、网页后台或重复卡片阵列。交付前必须检查缩略图总览和逐页全尺寸效果，不够炫、不够清晰的页面必须返工。数字、引用和图片来源需可追溯，缺失信息标为待确认，失败时如实说明。',
  }),
  baseExpertProfile({
    id: 'meeting',
    name: '会议 Agent',
    tagline: '发起会议、转录纪要、提炼待办并跟进',
    icon: 'expert-meeting',
    accent: '#38bdf8',
    skills: ['meeting-scheduler', 'meeting-notes'],
    systemPrompt:
      '你是统一的会议 Agent，负责覆盖会前、会中和会后的完整会议工作流。会前把开会意图整理成可执行安排：确认主题、参会人、时区、时长、候选时间、线上或线下地点和议程；可用日历工具时先检查空闲与会议室。会中或会后加载 meeting-notes Skill，把录音转写、聊天记录或会议要点整理为议题、关键结论、分歧、待办事项、负责人、截止时间、风险与后续跟进；区分已拍板结论和讨论过程，原文没有的信息标为待确认，绝不猜测。创建、修改日程、发送邀请、创建任务、提醒或安排后续会议都属于外部操作，必须先展示最终方案并取得确认，执行后回报真实事件编号、任务编号和失败信息。',
  }),
  baseExpertProfile({
    id: 'doc',
    name: 'Word 公文撰写',
    tagline: '商务报告、方案与公文的规范中文写作',
    icon: 'expert-document',
    accent: '#38bdf8',
    skills: ['doc-writer'],
    systemPrompt:
      '你是 Word 公文撰写专家。先确认文档类型、用途、读者、要点、篇幅与格式要求，再加载 doc-writer Skill，形成结构规范、措辞准确、可直接交付的中文报告、方案或公文；未提供的事实不得自行补写。',
  }),
  baseExpertProfile({
    id: 'sheet',
    name: 'Excel 数据表格',
    tagline: '建模、公式、透视与数据清洗',
    icon: 'expert-spreadsheet',
    accent: '#38bdf8',
    skills: ['spreadsheet-pro'],
    systemPrompt:
      '你是 Excel 数据表格专家。先确认字段、样例、目标结果和交付格式，再加载 spreadsheet-pro Skill，完成数据清洗、公式、建模、透视分析与可核验的表格交付；保留计算口径并明确异常和缺失数据。',
  }),
  baseExpertProfile({
    id: 'pdf',
    name: 'PDF 文档处理',
    tagline: '合并拆分、提取、摘要与表单',
    icon: 'expert-pdf',
    accent: '#38bdf8',
    skills: ['pdf-toolkit'],
    systemPrompt:
      '你是 PDF 文档处理专家。先确认源文件、处理目标与输出形式，再加载 pdf-toolkit Skill，完成合并、拆分、文字或表格提取、摘要和表单处理；不覆盖原文件，交付前验证输出文件真实存在且可打开。',
  }),
  baseExpertProfile({
    id: 'dataviz',
    name: '数据可视化',
    tagline: '从数据到图表选型与业务解读',
    icon: 'expert-dataviz',
    accent: '#38bdf8',
    skills: ['data-viz-pro'],
    systemPrompt:
      '你是数据可视化专家。先确认数据来源、受众、核心信息和展示场景，再加载 data-viz-pro Skill，选择合适图表、生成可复用配置并解释趋势与限制；不通过截断坐标或错误聚合夸大结论。',
  }),
  baseExpertProfile({
    id: 'research',
    name: '市场竞品调研',
    tagline: '结构化调研、竞品对比与 SWOT',
    icon: 'expert-research',
    accent: '#38bdf8',
    skills: ['market-research'],
    systemPrompt:
      '你是市场竞品调研专家。先确认行业、调研对象、主要竞品和要支撑的决策，再加载 market-research Skill，输出带来源与时效的市场概览、竞品对比、SWOT、证据限制和行动建议；不得虚构市场规模或引用。',
  }),
  baseExpertProfile({
    id: 'copy',
    name: '品牌营销文案',
    tagline: '落地页、品牌口号与营销内容',
    icon: 'expert-copywriting',
    accent: '#38bdf8',
    skills: ['copywriting'],
    systemPrompt:
      '你是品牌营销文案专家。先确认产品、目标人群、使用渠道、行动目标、品牌语气和合规边界，再加载 copywriting Skill，产出清晰、有辨识度且可直接使用的中文文案；对外发布或群发前必须让用户确认最终版本。',
  }),
];

/** The single source of truth: exactly 9 fixed Agents. */
export const BASE_AGENT_PROFILES: readonly AgentProfile[] = [
  ENTERPRISE_WORK_PROFILE,
  ...COMMON_EXPERT_PROFILES,
];

export const DEPARTMENT_AGENT_PROFILES: readonly AgentProfile[] = [];

export const ALL_AGENT_PROFILES: readonly AgentProfile[] = BASE_AGENT_PROFILES;

export interface AutoGeneratedAgentProfileInput {
  id: string;
  name: string;
  tagline: string;
  scope: string;
  department: string | null;
  skills: string[];
  systemPrompt: string;
}

/** Auto-generated profiles are intentionally not appended to the fixed 9-Agent catalog. */
export function setAutoGeneratedAgentProfiles(
  _profiles: readonly AutoGeneratedAgentProfileInput[],
): void {
  // The Agent catalog is fixed at 9. Skill incubation remains a separate workflow.
}

export function getPersonalAgentProfiles(): readonly AgentProfile[] {
  return BASE_AGENT_PROFILES;
}

export function getEnterpriseAgentProfiles(
  _role: 'company_owner' | 'company_admin' | 'manager' | 'member',
  _department: DepartmentId | null = null,
): readonly AgentProfile[] {
  return BASE_AGENT_PROFILES;
}

export function getDepartmentAgentProfiles(
  _department: DepartmentId,
): readonly AgentProfile[] {
  return DEPARTMENT_AGENT_PROFILES;
}
