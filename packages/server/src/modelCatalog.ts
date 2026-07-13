/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * 企业版只下发 Otto 托管模型的公开目录。上游 endpoint、密钥和真实采购价
 * 只存在于 API 中转站，绝不进入桌面协议。当前费率为 v1.7 产品占位规则，
 * 后台可通过 OTTO_ENTERPRISE_MODEL_CATALOG 整体替换。
 */

export type EnterpriseModelTier = 'standard' | 'premium';

export interface EnterpriseModelInfo {
  id: `otto:${string}`;
  displayName: string;
  vendor: string;
  /** API 中转站识别的内部模型键；不是上游 endpoint。 */
  modelId: string;
  tier: EnterpriseModelTier;
  source: 'otto';
  managed: true;
  /** 仅作用户横向比较；真实账本按输入/输出费率结算。 */
  creditMultiplier: number;
  inputCreditsPerMTok: number;
  outputCreditsPerMTok: number;
  pricingStatus: 'provisional';
  enabled: true;
}

function managed(
  value: Omit<
    EnterpriseModelInfo,
    'source' | 'managed' | 'pricingStatus' | 'enabled'
  >,
): EnterpriseModelInfo {
  return {
    ...value,
    source: 'otto',
    managed: true,
    pricingStatus: 'provisional',
    enabled: true,
  };
}

/** 国内第一阶段目录：模型族名保持稳定，具体上游版本由中转站后台映射。 */
export const ENTERPRISE_MODEL_CATALOG: EnterpriseModelInfo[] = [
  managed({
    id: 'otto:deepseek',
    displayName: 'DeepSeek 通用',
    vendor: 'DeepSeek',
    modelId: 'deepseek-default',
    tier: 'standard',
    creditMultiplier: 1,
    inputCreditsPerMTok: 100,
    outputCreditsPerMTok: 400,
  }),
  managed({
    id: 'otto:qwen',
    displayName: '通义千问 通用',
    vendor: '通义千问',
    modelId: 'qwen-default',
    tier: 'standard',
    creditMultiplier: 1.2,
    inputCreditsPerMTok: 120,
    outputCreditsPerMTok: 480,
  }),
  managed({
    id: 'otto:glm',
    displayName: '智谱 GLM 通用',
    vendor: '智谱 GLM',
    modelId: 'glm-default',
    tier: 'standard',
    creditMultiplier: 1.3,
    inputCreditsPerMTok: 130,
    outputCreditsPerMTok: 520,
  }),
  managed({
    id: 'otto:doubao',
    displayName: '豆包 通用',
    vendor: '豆包',
    modelId: 'doubao-default',
    tier: 'standard',
    creditMultiplier: 1.1,
    inputCreditsPerMTok: 110,
    outputCreditsPerMTok: 440,
  }),
  managed({
    id: 'otto:kimi',
    displayName: 'Kimi 长文本',
    vendor: 'Kimi',
    modelId: 'kimi-default',
    tier: 'standard',
    creditMultiplier: 1.6,
    inputCreditsPerMTok: 160,
    outputCreditsPerMTok: 640,
  }),
  managed({
    id: 'otto:premium-reasoning',
    displayName: '高端推理模型',
    vendor: '高端模型',
    modelId: 'premium-reasoning',
    tier: 'premium',
    creditMultiplier: 4,
    inputCreditsPerMTok: 400,
    outputCreditsPerMTok: 1600,
  }),
  managed({
    id: 'otto:premium-multimodal',
    displayName: '高端多模态模型',
    vendor: '高端模型',
    modelId: 'premium-multimodal',
    tier: 'premium',
    creditMultiplier: 6,
    inputCreditsPerMTok: 600,
    outputCreditsPerMTok: 2400,
  }),
];

function isCatalogItem(value: unknown): value is Omit<EnterpriseModelInfo, 'source' | 'managed' | 'pricingStatus' | 'enabled'> {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item['id'] === 'string' &&
    item['id'].startsWith('otto:') &&
    typeof item['displayName'] === 'string' &&
    typeof item['vendor'] === 'string' &&
    typeof item['modelId'] === 'string' &&
    (item['tier'] === 'standard' || item['tier'] === 'premium') &&
    typeof item['creditMultiplier'] === 'number' &&
    item['creditMultiplier'] > 0 &&
    typeof item['inputCreditsPerMTok'] === 'number' &&
    item['inputCreditsPerMTok'] >= 0 &&
    typeof item['outputCreditsPerMTok'] === 'number' &&
    item['outputCreditsPerMTok'] >= 0
  );
}

export function loadEnterpriseModelCatalog(): EnterpriseModelInfo[] {
  const raw = process.env['OTTO_ENTERPRISE_MODEL_CATALOG']?.trim();
  if (!raw) return ENTERPRISE_MODEL_CATALOG;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isCatalogItem)) {
      return ENTERPRISE_MODEL_CATALOG;
    }
    const ids = new Set(parsed.map((item) => item.id));
    if (ids.size !== parsed.length) return ENTERPRISE_MODEL_CATALOG;
    return parsed.map((item) => managed(item));
  } catch {
    return ENTERPRISE_MODEL_CATALOG;
  }
}
