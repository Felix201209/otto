/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENTERPRISE_MODEL_CATALOG,
  loadEnterpriseModelCatalog,
} from './modelCatalog.js';

afterEach(() => vi.unstubAllEnvs());

describe('企业版 Otto 托管模型目录', () => {
  it('覆盖国内主流模型家族，并明确展示积分倍率', () => {
    const providers = new Set(ENTERPRISE_MODEL_CATALOG.map((model) => model.vendor));
    expect(providers).toEqual(
      new Set(['DeepSeek', '通义千问', '智谱 GLM', '豆包', 'Kimi', '高端模型']),
    );
    expect(ENTERPRISE_MODEL_CATALOG.find((model) => model.id === 'otto:deepseek')?.creditMultiplier).toBe(1);
    expect(
      ENTERPRISE_MODEL_CATALOG.filter((model) => model.tier === 'premium').every(
        (model) => model.creditMultiplier > 1,
      ),
    ).toBe(true);
  });

  it('目录只下发 Otto 模型 id，不向客户端暴露上游 baseUrl 或密钥', () => {
    for (const model of ENTERPRISE_MODEL_CATALOG) {
      expect(model.id.startsWith('otto:')).toBe(true);
      expect(model).not.toHaveProperty('baseUrl');
      expect(JSON.stringify(model)).not.toMatch(/apiKey|secret/i);
    }
  });

  it('支持后台用 JSON 环境变量原子替换目录，非法配置回退内置目录', () => {
    vi.stubEnv(
      'OTTO_ENTERPRISE_MODEL_CATALOG',
      JSON.stringify([
        {
          id: 'otto:company-fast',
          displayName: '企业极速模型',
          vendor: 'Otto',
          modelId: 'company-fast',
          tier: 'standard',
          creditMultiplier: 1.2,
          inputCreditsPerMTok: 100,
          outputCreditsPerMTok: 400,
        },
      ]),
    );
    expect(loadEnterpriseModelCatalog()).toEqual([
      expect.objectContaining({ id: 'otto:company-fast', managed: true, source: 'otto' }),
    ]);

    vi.stubEnv('OTTO_ENTERPRISE_MODEL_CATALOG', '{bad json');
    expect(loadEnterpriseModelCatalog()).toEqual(ENTERPRISE_MODEL_CATALOG);
  });
});
