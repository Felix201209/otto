/**
 * @license
 * Copyright 2026 Easy Code team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { type HistoryItem, type HistoryItemInfo } from '../types.js';
import { CustomModelConfig, Config } from 'otto-core';
import { t } from '../utils/i18n.js';
import { addOrUpdateCustomModel, loadCustomModels } from '../../config/customModelsStorage.js';

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
            ? `✅ Custom model "${list[0].displayName}" saved successfully!`
            : `✅ ${list.length} custom models saved successfully!`;
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
              '\n\n💡 Use /model to select your custom model.\n📁 Saved to: ~/.deepv/custom-models.json',
          } as HistoryItemInfo,
          Date.now(),
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        addItem(
          {
            type: 'error',
            text: `❌ Failed to save custom model: ${errorMessage}`,
          } as any,
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
        text: 'ℹ️ Custom model configuration cancelled.',
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
