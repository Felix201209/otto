/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config/modelsDevCatalog.js', () => ({
  loadModelsDevCatalog: vi.fn().mockResolvedValue([]),
  findProvider: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./config/settings.js', () => ({
  loadSettings: vi.fn(),
  SettingScope: { User: 'User' },
}));

vi.mock('./config/customModelsStorage.js', () => ({
  addOrUpdateCustomModel: vi.fn(),
  writeSecretFile: vi.fn().mockReturnValue('/mock/.otto-user/secrets/mock'),
}));

import { runNonInteractiveModelSetup } from './modelSetupCli.js';
import { loadModelsDevCatalog } from './config/modelsDevCatalog.js';

describe('runNonInteractiveModelSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('缺取值的参数（missingValueFlags）', () => {
    it('--key 后面跟了另一个 flag 时报中文错误并非零退出', async () => {
      // 对应 `otto setup --provider zhipuai --key --model glm-5.1`：
      // "--model" 绝不能被当成 key 写进密钥文件
      const result = await runNonInteractiveModelSetup({
        provider: 'zhipuai',
        model: 'glm-5.1',
        missingValueFlags: ['--key'],
      });

      expect(result.code).toBe(1);
      expect(result.text).toContain('--key');
      expect(result.text).toContain('缺少取值');
    });

    it('多个缺值参数一并列出', async () => {
      const result = await runNonInteractiveModelSetup({
        missingValueFlags: ['--key', '--model'],
      });

      expect(result.code).toBe(1);
      expect(result.text).toContain('--key');
      expect(result.text).toContain('--model');
    });

    it('缺值检查在加载 models.dev 目录之前（不触网即报错）', async () => {
      await runNonInteractiveModelSetup({ missingValueFlags: ['--key'] });
      expect(loadModelsDevCatalog).not.toHaveBeenCalled();
    });
  });

  describe('必填参数缺失', () => {
    it('缺 --provider 时报错并非零退出', async () => {
      const result = await runNonInteractiveModelSetup({ model: 'glm-5.1' });
      expect(result.code).toBe(1);
      expect(result.text).toContain('--provider');
    });

    it('缺 --model 时报错并非零退出', async () => {
      const result = await runNonInteractiveModelSetup({ provider: 'zhipuai' });
      expect(result.code).toBe(1);
      expect(result.text).toContain('--model');
    });
  });
});
