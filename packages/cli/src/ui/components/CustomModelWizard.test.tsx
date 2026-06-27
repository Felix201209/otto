/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 验证「品牌预设 → 输 key → 从 models.dev 拉模型列表交互选择」这条新流程：
 * 渲染向导 → 选中智谱 GLM → 输入 key → 断言模型选择步渲染出 models.dev 的 glm-5.1。
 *
 * 输入机制说明：向导每一步只有一个 project `useKeypress` 处于 active，所以用
 * 「last-write-wins」单 handler mock（沿用 InputPrompt.test 的范式）即可驱动到
 * MODEL_SELECT 步；选择列表本身用 ink 原生 useInput，这里只断言其渲染结果。
 */
import { render } from 'ink-testing-library';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { Key } from '../hooks/useKeypress.js';

let keyPressHandler: ((key: Key) => void) | null = null;

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn((handler: (key: Key) => void, options?: { isActive?: boolean }) => {
    if (options?.isActive !== false) {
      keyPressHandler = handler;
    }
  }),
}));

vi.mock('../../config/modelsDevCatalog.js', () => ({
  loadModelsDevCatalog: vi.fn(async () => [
    {
      id: 'zhipuai',
      name: 'Zhipu AI',
      api: 'https://open.bigmodel.cn/api/paas/v4',
      envVar: 'ZHIPU_API_KEY',
      protocol: 'openai',
      models: [
        { id: 'glm-5.1', name: 'GLM-5.1', reasoning: true, toolCall: true },
        { id: 'glm-4.6', name: 'GLM-4.6', toolCall: true },
      ],
    },
    {
      id: 'moonshotai',
      name: 'Moonshot AI',
      api: 'https://api.moonshot.cn/v1',
      envVar: 'MOONSHOT_API_KEY',
      protocol: 'openai',
      models: [{ id: 'kimi-k2', name: 'Kimi K2', toolCall: true }],
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      api: 'https://api.deepseek.com',
      envVar: 'DEEPSEEK_API_KEY',
      protocol: 'openai',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', toolCall: true }],
    },
  ]),
  findProvider: (provs: Array<{ id: string }>, q: string) =>
    provs.find((p) => p.id === q) ?? provs.find((p) => p.id === 'zhipuai'),
}));

const { CustomModelWizard } = await import('./CustomModelWizard.js');

function key(partial: Partial<Key>): Key {
  return {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    sequence: '',
    ...partial,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function waitForFrame(
  lastFrame: () => string | undefined,
  needle: string,
  tries = 12,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if ((lastFrame() ?? '').includes(needle)) return;
    await flush();
  }
}

describe('CustomModelWizard — models.dev 模型选择流程', () => {
  beforeEach(() => {
    keyPressHandler = null;
  });

  it('选智谱 GLM 预设 → 输 key → 渲染 models.dev 模型列表(含 glm-5.1)', async () => {
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    const { lastFrame } = render(
      <CustomModelWizard onComplete={onComplete} onCancel={onCancel} />,
    );
    await flush();

    // 初始：供应商选择列表里有智谱 GLM 预设（中文「智谱 GLM」/ 英文「Zhipu GLM」）
    expect(lastFrame()).toMatch(/智谱 GLM|Zhipu GLM/);

    // 下移两格(EasyRouter→全部供应商→GLM)，回车选中
    keyPressHandler?.(key({ name: 'down' }));
    await flush();
    keyPressHandler?.(key({ name: 'down' }));
    await flush();
    keyPressHandler?.(key({ name: 'return' }));
    await flush();

    // 现在在「输入 API Key」步
    expect(lastFrame()).toContain('Key');

    // 逐字符输入 key，再回车提交
    for (const ch of 'sk-test-key') {
      keyPressHandler?.(key({ sequence: ch }));
    }
    keyPressHandler?.(key({ name: 'return' }));

    // 进入 MODEL_SELECT：等异步拉取 + 渲染出 glm-5.1
    await waitForFrame(lastFrame, 'glm-5.1');
    expect(lastFrame()).toContain('glm-5.1');
    // 列表末尾应有「手动输入」兜底项（中文「手动输入」/ 英文「Enter model name manually」）
    expect(lastFrame()).toMatch(/手动输入|manually/);
    // 不应误触发完成回调
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('可搜索全量供应商：输 moon 筛到 Moonshot → 选中 → 输 key → 列出 kimi-k2', async () => {
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    const { lastFrame } = render(
      <CustomModelWizard onComplete={onComplete} onCancel={onCancel} />,
    );
    await flush();

    // 进入「🌐 全部供应商（可搜索）」(EasyRouter=0, 它=1)
    keyPressHandler?.(key({ name: 'down' }));
    await flush();
    keyPressHandler?.(key({ name: 'return' }));
    await waitForFrame(lastFrame, '🔎'); // 进入搜索步(🔎 搜索框图标，locale 无关)
    await waitForFrame(lastFrame, 'Zhipu'); // 等异步加载完供应商清单(mock 数据 name)

    // 输入 "moon" 筛选 → 应只剩 Moonshot AI
    for (const ch of 'moon') {
      keyPressHandler?.(key({ sequence: ch }));
    }
    await flush();
    expect(lastFrame()).toContain('Moonshot AI');
    expect(lastFrame()).not.toContain('DeepSeek');

    // 回车选中 → 进入输 key 步
    keyPressHandler?.(key({ name: 'return' }));
    await flush();
    expect(lastFrame()).toContain('Key');

    // 输 key + 回车 → 模型选择步列出 kimi-k2
    for (const ch of 'sk-x') keyPressHandler?.(key({ sequence: ch }));
    keyPressHandler?.(key({ name: 'return' }));
    await waitForFrame(lastFrame, 'kimi-k2');
    expect(lastFrame()).toContain('kimi-k2');
    expect(onComplete).not.toHaveBeenCalled();
  });
});
