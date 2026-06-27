/**
 * @license
 * Copyright 2026 Felix
 * SPDX-License-Identifier: Apache-2.0
 */

import { act,renderHook } from '@testing-library/react';
import { CustomModelConfig,type Config } from 'otto-core';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import type { LoadedSettings } from '../../config/settings.js';
import { useCustomModelWizard } from './useCustomModelWizard.js';

// Mock the customModelsStorage module
vi.mock('../../config/customModelsStorage.js', () => ({
  addOrUpdateCustomModel: vi.fn(),
  loadCustomModels: vi.fn(() => []),
}));

import { addOrUpdateCustomModel,loadCustomModels } from '../../config/customModelsStorage.js';

describe('useCustomModelWizard', () => {
  const mockLoadedSettings = {} as Partial<LoadedSettings> as LoadedSettings;
  const mockAddItem = vi.fn();
  const mockConfig = {
    setCustomModels: vi.fn(),
  } as Partial<Config> as Config;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with wizard closed', () => {
    const { result } = renderHook(() =>
      useCustomModelWizard(mockLoadedSettings, mockAddItem, mockConfig)
    );

    expect(result.current.isCustomModelWizardOpen).toBe(false);
  });

  it('should open wizard when openCustomModelWizard is called', () => {
    const { result } = renderHook(() =>
      useCustomModelWizard(mockLoadedSettings, mockAddItem, mockConfig)
    );

    act(() => {
      result.current.openCustomModelWizard();
    });

    expect(result.current.isCustomModelWizardOpen).toBe(true);
  });

  it('should save model and close wizard when handleWizardComplete is called', () => {
    const { result } = renderHook(() =>
      useCustomModelWizard(mockLoadedSettings, mockAddItem, mockConfig)
    );

    const testConfig: CustomModelConfig = {
      displayName: 'Test Model',
      provider: 'openai',
      baseUrl: 'http://localhost:8000',
      apiKey: 'test-key',
      modelId: 'gpt-4',
      enabled: true,
    };

    // Open wizard first
    act(() => {
      result.current.openCustomModelWizard();
    });
    expect(result.current.isCustomModelWizardOpen).toBe(true);

    // Complete wizard
    act(() => {
      result.current.handleWizardComplete(testConfig);
    });

    // Verify addOrUpdateCustomModel was called with the config
    expect(addOrUpdateCustomModel).toHaveBeenCalledWith(testConfig);

    // Verify loadCustomModels was called for hot reload
    expect(loadCustomModels).toHaveBeenCalled();

    // Verify config.setCustomModels was called
    expect(mockConfig.setCustomModels).toHaveBeenCalled();

    // Verify wizard was closed
    expect(result.current.isCustomModelWizardOpen).toBe(false);

    // Verify success message was added
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('Test Model'),
      }),
      expect.any(Number)
    );
  });

  it('should close wizard and show message when handleWizardCancel is called', () => {
    const { result } = renderHook(() =>
      useCustomModelWizard(mockLoadedSettings, mockAddItem, mockConfig)
    );

    // Open wizard first
    act(() => {
      result.current.openCustomModelWizard();
    });
    expect(result.current.isCustomModelWizardOpen).toBe(true);

    // Cancel wizard
    act(() => {
      result.current.handleWizardCancel();
    });

    // Verify wizard was closed
    expect(result.current.isCustomModelWizardOpen).toBe(false);

    // Verify cancel message was added
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringContaining('已取消'),
      }),
      expect.any(Number)
    );
  });

  it('should handle save errors gracefully', () => {
    // Make addOrUpdateCustomModel throw an error
    vi.mocked(addOrUpdateCustomModel).mockImplementationOnce(() => {
      throw new Error('Storage error');
    });

    const { result } = renderHook(() =>
      useCustomModelWizard(mockLoadedSettings, mockAddItem, mockConfig)
    );

    const testConfig: CustomModelConfig = {
      displayName: 'Test Model',
      provider: 'openai',
      baseUrl: 'http://localhost:8000',
      apiKey: 'test-key',
      modelId: 'gpt-4',
      enabled: true,
    };

    act(() => {
      result.current.handleWizardComplete(testConfig);
    });

    // Verify error message was added
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('Storage error'),
      }),
      expect.any(Number)
    );
  });

  it('persists every config when handleWizardComplete is given an array (EasyRouter batch)', () => {
    const { result } = renderHook(() =>
      useCustomModelWizard(mockLoadedSettings, mockAddItem, mockConfig),
    );

    const batch: CustomModelConfig[] = [
      {
        displayName: 'gpt-5.4',
        provider: 'openai-responses',
        baseUrl: 'https://llm-endpoint.net/v1',
        apiKey: 'sk-xxx',
        modelId: 'gpt-5.4',
        enabled: true,
      },
      {
        displayName: 'claude-opus-4-7',
        provider: 'anthropic',
        baseUrl: 'https://llm-endpoint.net/v1',
        apiKey: 'sk-xxx',
        modelId: 'claude-opus-4-7',
        enabled: true,
      },
    ];

    act(() => {
      result.current.openCustomModelWizard();
    });
    act(() => {
      result.current.handleWizardComplete(batch);
    });

    expect(addOrUpdateCustomModel).toHaveBeenCalledTimes(batch.length);
    expect(addOrUpdateCustomModel).toHaveBeenNthCalledWith(1, batch[0]);
    expect(addOrUpdateCustomModel).toHaveBeenNthCalledWith(2, batch[1]);

    // Hot-reload pulled once after the batch.
    expect(loadCustomModels).toHaveBeenCalled();
    expect(mockConfig.setCustomModels).toHaveBeenCalled();

    // Wizard closed.
    expect(result.current.isCustomModelWizardOpen).toBe(false);

    // Success message references the batch count and includes both names.
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        text: expect.stringMatching(/2 个自定义模型/),
      }),
      expect.any(Number),
    );
    const messageCalls = mockAddItem.mock.calls;
    const lastInfo = messageCalls[messageCalls.length - 1][0].text as string;
    expect(lastInfo).toContain('gpt-5.4');
    expect(lastInfo).toContain('claude-opus-4-7');
  });

  it('does nothing when handleWizardComplete is called with an empty array', () => {
    const { result } = renderHook(() =>
      useCustomModelWizard(mockLoadedSettings, mockAddItem, mockConfig),
    );

    act(() => {
      result.current.openCustomModelWizard();
    });
    act(() => {
      result.current.handleWizardComplete([]);
    });

    expect(addOrUpdateCustomModel).not.toHaveBeenCalled();
    expect(mockConfig.setCustomModels).not.toHaveBeenCalled();
    expect(result.current.isCustomModelWizardOpen).toBe(false);
  });
});
