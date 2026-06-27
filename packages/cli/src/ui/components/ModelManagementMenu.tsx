/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box,Text } from 'ink';
import { Config,CustomModelConfig } from 'otto-core';
import React,{ useCallback,useState } from 'react';
import { addOrUpdateCustomModel,deleteCustomModel,loadCustomModels } from '../../config/customModelsStorage.js';
import { LoadedSettings,SettingScope } from '../../config/settings.js';
import { Colors } from '../colors.js';
import { t,tp } from '../utils/i18n.js';
import { CustomModelWizard } from './CustomModelWizard.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';

interface ModelManagementMenuProps {
  /** Callback when management is complete (returns true if models were modified) */
  onComplete: (modelsModified: boolean) => void;

  /** Callback when user cancels */
  onCancel: () => void;

  /** Settings object */
  settings: LoadedSettings;

  /** Config object */
  config: Config;
}

type MenuState = 'main' | 'add' | 'delete' | 'confirm-delete';

export function ModelManagementMenu({
  onComplete,
  onCancel: _onCancel,
  settings,
  config,
}: ModelManagementMenuProps): React.JSX.Element {
  const [menuState, setMenuState] = useState<MenuState>('main');
  const [selectedModelToDelete, setSelectedModelToDelete] = useState<CustomModelConfig | null>(null);
  const [modelsModified, setModelsModified] = useState(false);

  // 主菜单选项
  const mainMenuItems = [
    { label: t('model.management.add.custom'), value: 'add' },
    { label: t('model.management.delete.custom'), value: 'delete' },
    { label: t('model.management.back'), value: 'back' },
  ];

  // 处理主菜单选择
  const handleMainMenuSelect = useCallback((value: string) => {
    if (value === 'back') {
      onComplete(modelsModified);
    } else if (value === 'add') {
      setMenuState('add');
    } else if (value === 'delete') {
      setMenuState('delete');
    }
  }, [modelsModified, onComplete]);

  // 处理添加模型完成
  // Accepts either a single config (manual flow) or an array (EasyRouter batch).
  const handleAddComplete = useCallback(
    (newModels: CustomModelConfig | CustomModelConfig[]) => {
      const list = Array.isArray(newModels) ? newModels : [newModels];
      if (list.length > 0) {
        for (const model of list) {
          addOrUpdateCustomModel(model);
        }
        setModelsModified(true);

        // 🔥 热重载：立即更新 Config 实例，让当前会话可以使用新配置的模型
        const updatedModels = loadCustomModels();
        config.setCustomModels(updatedModels);
        if (process.env.DEBUG) {
          console.log(
            `[ModelManagement] Added/Updated ${list.length} model(s): ${list
              .map((m) => m.displayName)
              .join(', ')}`,
          );
        }
      }
      setMenuState('main');
    },
    [config],
  );

  // 处理添加模型取消
  const handleAddCancel = useCallback(() => {
    setMenuState('main');
  }, []);

  // 获取所有自定义模型
  const customModels = config.getCustomModels() || [];

  // 删除模型列表
  const deleteMenuItems: Array<{
    label: string;
    value: string;
    model: CustomModelConfig | null;
  }> = [
    ...customModels.map((model) => ({
      label: `${model.displayName} (${model.provider})`,
      value: model.displayName,
      model,
    })),
    { label: t('model.management.back'), value: '__back__', model: null },
  ];

  // 处理删除菜单选择
  // 回调内现查最新模型列表，避免依赖每次渲染都新建的 customModels 数组导致 useCallback 失稳
  const handleDeleteMenuSelect = useCallback((value: string) => {
    if (value === '__back__') {
      setMenuState('main');
      return;
    }

    const modelToDelete = (config.getCustomModels() || []).find(m => m.displayName === value);
    if (modelToDelete) {
      setSelectedModelToDelete(modelToDelete);
      setMenuState('confirm-delete');
    }
  }, [config]);

  // 确认删除选项
  const confirmDeleteItems = [
    { label: t('model.management.delete.confirm.yes'), value: 'yes' },
    { label: t('model.management.delete.confirm.no'), value: 'no' },
  ];

  // 处理删除确认
  const handleConfirmDelete = useCallback((value: string) => {
    if (value === 'yes' && selectedModelToDelete) {
      const deletedModelId = `custom:${selectedModelToDelete.displayName}`;

      // 删除模型（使用独立存储系统）
      const deleted = deleteCustomModel(deletedModelId);

      if (deleted) {
        setModelsModified(true);

        // 🔥 热重载：立即更新 Config 实例
        const updatedModels = loadCustomModels();
        config.setCustomModels(updatedModels);
        if (process.env.DEBUG) { console.log(`[ModelManagement] Deleted model: ${deletedModelId}`); }

        // 检查是否删除的是当前模型
        const currentModel = settings.merged.preferredModel;

        if (currentModel === deletedModelId) {
          // 尝试切换到其他自定义模型
          if (updatedModels.length > 0) {
            // 切换到下一个自定义模型
            const nextModel = `custom:${updatedModels[0].displayName}`;
            settings.setValue(SettingScope.User, 'preferredModel', nextModel);
            if (process.env.DEBUG) { console.log(`[ModelManagement] Switched to next custom model: ${nextModel}`); }
          } else {
            // 没有其他自定义模型了，切换回 auto
            settings.setValue(SettingScope.User, 'preferredModel', 'auto');
            if (process.env.DEBUG) { console.log('[ModelManagement] Switched to auto model (last custom model deleted)'); }
          }
        }
      }
    }

    setSelectedModelToDelete(null);
    setMenuState('delete');
  }, [selectedModelToDelete, config, settings]);

  // 渲染不同的菜单状态
  if (menuState === 'add') {
    return (
      <CustomModelWizard
        onComplete={handleAddComplete}
        onCancel={handleAddCancel}
      />
    );
  }

  if (menuState === 'confirm-delete' && selectedModelToDelete) {
    return (
      <Box
        borderStyle="round"
        borderColor={Colors.Gray}
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text bold color={Colors.AccentYellow}>
          {t('model.management.delete.confirm.title')}
        </Text>
        <Box marginTop={1}>
          <Text>
            {tp('model.management.delete.confirm.message', { model: selectedModelToDelete.displayName })}
          </Text>
        </Box>
        <Box marginTop={1}>
          <RadioButtonSelect
            items={confirmDeleteItems}
            initialIndex={1}
            onSelect={handleConfirmDelete}
            onHighlight={() => {}}
            isFocused={true}
          />
        </Box>
      </Box>
    );
  }

  if (menuState === 'delete') {
    if (customModels.length === 0) {
      return (
        <Box
          borderStyle="round"
          borderColor={Colors.Gray}
          flexDirection="column"
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={1}
          paddingRight={1}
        >
          <Text bold>{'>'} {t('model.management.delete.title')}</Text>
          <Box marginTop={1}>
            <Text color={Colors.Gray}>{t('model.management.delete.no.models')}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={Colors.Gray}>{t('model.management.delete.hint.back')}</Text>
          </Box>
        </Box>
      );
    }

    return (
      <Box
        borderStyle="round"
        borderColor={Colors.Gray}
        flexDirection="column"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <Text bold>{'>'} {t('model.management.delete.title')}</Text>
        <Box marginTop={1}>
          <RadioButtonSelect
            items={deleteMenuItems}
            initialIndex={0}
            onSelect={handleDeleteMenuSelect}
            onHighlight={() => {}}
            isFocused={true}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={Colors.Gray}>{t('model.management.delete.hint')}</Text>
        </Box>
      </Box>
    );
  }

  // Main menu
  return (
    <Box
      borderStyle="round"
      borderColor={Colors.Gray}
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <Text bold>{'>'} {t('model.management.title')}</Text>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={mainMenuItems}
          initialIndex={0}
          onSelect={handleMainMenuSelect}
          onHighlight={() => {}}
          isFocused={true}
        />
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.Gray}>{t('model.management.hint')}</Text>
      </Box>
    </Box>
  );
}
