/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config,CustomModelConfig } from 'otto-core';
import { useCallback,useState } from 'react';
import { addOrUpdateCustomModel,loadCustomModels } from '../../config/customModelsStorage.js';
import { LoadedSettings } from '../../config/settings.js';
import { type HistoryItem,type HistoryItemInfo } from '../types.js';

interface UseCustomModelWizardReturn {
  isCustomModelWizardOpen: boolean;
  openCustomModelWizard: () => void;
  /**
   * Persist the wizard result. Accepts either a single config (manual flow)
   * or an array of configs (e.g. EasyRouter batch import).
   */
  handleWizardComplete: (
    configs: CustomModelConfig | CustomModelConfig[],
  ) => void;
  handleWizardCancel: () => void;
}

export const useCustomModelWizard = (
  loadedSettings: LoadedSettings,
  addItem: (item: Omit<HistoryItem, 'id'>, timestamp: number) => void,
  config?: Config,
): UseCustomModelWizardReturn => {
  const [isCustomModelWizardOpen, setIsCustomModelWizardOpen] = useState(false);

  const openCustomModelWizard = useCallback(() => {
    setIsCustomModelWizardOpen(true);
  }, []);

  const handleWizardComplete = useCallback(
    (modelConfig: CustomModelConfig | CustomModelConfig[]) => {
      const list = Array.isArray(modelConfig) ? modelConfig : [modelConfig];

      if (list.length === 0) {
        // Defensive: nothing to save — just close.
        setIsCustomModelWizardOpen(false);
        return;
      }

      try {
        for (const cfg of list) {
          addOrUpdateCustomModel(cfg);
        }

        // 🔥 热重载：立即更新 Config 实例，让当前会话可以使用新配置的模型
        if (config) {
          const updatedModels = loadCustomModels();
          config.setCustomModels(updatedModels);
        }

        // 关闭向导
        setIsCustomModelWizardOpen(false);

        // 显示成功消息
        const successMessage =
          list.length === 1
            ? `✅ 已保存自定义模型「${list[0].displayName}」`
            : `✅ 已保存 ${list.length} 个自定义模型`;
        const detailLines =
          list.length === 1
            ? ''
            : '\n' +
              list.map((m) => `   • ${m.displayName} [${m.provider}]`).join('\n');
        addItem(
          {
            type: 'info',
            text:
              successMessage +
              detailLines +
              '\n\n💡 下一步：用 /model 选中它即可启用（尚未自动设为默认）。\n📁 已保存到：~/.otto-user/custom-models.json',
          } as HistoryItemInfo,
          Date.now(),
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const historyItem: Omit<HistoryItem, 'id'> = {
          type: 'error',
          text: `❌ 保存自定义模型失败：${errorMessage}`,
        };
        addItem(
          historyItem,
          Date.now(),
        );
      }
    },
    [addItem, config],
  );

  const handleWizardCancel = useCallback(() => {
    setIsCustomModelWizardOpen(false);
    addItem(
      {
        type: 'info',
        text: 'ℹ️ 已取消自定义模型配置。',
      } as HistoryItemInfo,
      Date.now(),
    );
  }, [addItem]);

  return {
    isCustomModelWizardOpen,
    openCustomModelWizard,
    handleWizardComplete,
    handleWizardCancel,
  };
};
