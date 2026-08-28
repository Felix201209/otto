/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import type { GeneratedIconName } from './components/GeneratedIcon.js';
import type { ModuleIconSource } from './components/ModuleIcon.js';

export interface CustomAgentPresetIcon {
  id: GeneratedIconName;
  label: string;
}

export type CustomAgentIcon =
  | { kind: 'preset'; name: GeneratedIconName }
  | { kind: 'upload'; dataUrl: string };

export const CUSTOM_AGENT_ICON_MAX_DATA_URL_LENGTH = 96_000;
const CUSTOM_AGENT_ICON_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const CUSTOM_AGENT_ICON_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const CUSTOM_AGENT_PRESET_ICONS: readonly CustomAgentPresetIcon[] = Object.freeze([
  { id: 'agent-ceo', label: '经营管理' },
  { id: 'agent-meeting-initiator', label: '发起会议' },
  { id: 'agent-meeting-followup', label: '会议跟进' },
  { id: 'agent-ceo-strategy', label: '战略规划' },
  { id: 'agent-ceo-operating-review', label: '经营复盘' },
  { id: 'agent-ceo-decision-brief', label: '决策简报' },
  { id: 'agent-ceo-executive-meeting', label: '管理会议' },
  { id: 'agent-product-requirements', label: '产品需求' },
  { id: 'agent-product-delivery', label: '项目交付' },
  { id: 'agent-technical-review', label: '技术评审' },
  { id: 'agent-product-data', label: '数据分析' },
  { id: 'agent-marketing-research', label: '市场调研' },
  { id: 'agent-marketing-content', label: '内容营销' },
  { id: 'agent-marketing-campaign', label: '营销活动' },
  { id: 'agent-marketing-performance', label: '营销效果' },
  { id: 'agent-sales-lead-research', label: '销售线索' },
  { id: 'agent-sales-solution', label: '销售方案' },
  { id: 'agent-sales-meeting-followup', label: '客户跟进' },
  { id: 'agent-customer-success', label: '客户成功' },
  { id: 'agent-finance-budget', label: '财务预算' },
  { id: 'agent-finance-analysis', label: '财务分析' },
  { id: 'agent-finance-reimbursement', label: '费用报销' },
  { id: 'agent-finance-report', label: '财务报告' },
  { id: 'agent-hr-recruiting', label: '人才招聘' },
  { id: 'agent-hr-onboarding', label: '员工入职' },
  { id: 'agent-hr-performance', label: '绩效管理' },
  { id: 'agent-admin-coordination', label: '行政协同' },
  { id: 'expert-presentation', label: '演示文稿' },
  { id: 'expert-document', label: '文档处理' },
  { id: 'expert-spreadsheet', label: '数据表格' },
]);

const PRESET_NAMES = new Set<GeneratedIconName>(
  CUSTOM_AGENT_PRESET_ICONS.map((item) => item.id),
);
const UPLOADED_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isCustomAgentIcon(value: unknown): value is CustomAgentIcon {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const icon = value as Record<string, unknown>;
  if (icon.kind === 'preset') {
    return typeof icon.name === 'string' && PRESET_NAMES.has(icon.name as GeneratedIconName);
  }
  if (icon.kind !== 'upload' || typeof icon.dataUrl !== 'string') return false;
  return icon.dataUrl.length <= CUSTOM_AGENT_ICON_MAX_DATA_URL_LENGTH
    && UPLOADED_IMAGE_DATA_URL.test(icon.dataUrl);
}

export function customAgentIconToModuleIcon(
  icon: CustomAgentIcon | undefined,
): ModuleIconSource {
  if (icon?.kind === 'preset') return `generated:${icon.name}`;
  if (icon?.kind === 'upload') return { kind: 'image', src: icon.dataUrl };
  return 'custom-agent';
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose(): void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  if (typeof globalThis.createImageBitmap === 'function') {
    const bitmap = await globalThis.createImageBitmap(file, { imageOrientation: 'from-image' });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      dispose: () => bitmap.close(),
    };
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (cause) {
    URL.revokeObjectURL(objectUrl);
    throw cause;
  }
}

function renderSquareDataUrl(
  image: DecodedImage,
  side: number,
  quality: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前设备无法处理这张图片');
  const sourceSide = Math.min(image.width, image.height);
  const sourceX = (image.width - sourceSide) / 2;
  const sourceY = (image.height - sourceSide) / 2;
  context.drawImage(
    image.source,
    sourceX,
    sourceY,
    sourceSide,
    sourceSide,
    0,
    0,
    side,
    side,
  );
  return canvas.toDataURL('image/webp', quality);
}

export async function createUploadedCustomAgentIcon(file: File): Promise<CustomAgentIcon> {
  if (!CUSTOM_AGENT_ICON_MIME_TYPES.has(file.type)) {
    throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  }
  if (file.size > CUSTOM_AGENT_ICON_MAX_UPLOAD_BYTES) {
    throw new Error('图片不能超过 5MB');
  }
  const image = await decodeImage(file).catch(() => {
    throw new Error('图片无法读取，请换一张图片');
  });
  try {
    if (!image.width || !image.height) throw new Error('图片尺寸无效');
    const attempts = [
      { side: 256, quality: 0.82 },
      { side: 192, quality: 0.76 },
      { side: 128, quality: 0.7 },
    ];
    for (const attempt of attempts) {
      const dataUrl = renderSquareDataUrl(image, attempt.side, attempt.quality);
      const icon: CustomAgentIcon = { kind: 'upload', dataUrl };
      if (isCustomAgentIcon(icon)) return icon;
    }
    throw new Error('图片处理后仍然过大，请换一张图片');
  } finally {
    image.dispose();
  }
}
