/**
 * Settings Dialog Component
 * 设置对话框组件（包含 YOLO 模式和 MCP 管理）
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useYoloMode } from '../hooks/useProjectSettings';
import { useTranslation } from '../hooks/useTranslation';
import { ExecutionSettingsPanel } from './settings/ExecutionSettingsPanel';
import { MCPSettingsPanel } from './settings/MCPSettingsPanel';
import { webviewModelService } from '../services/webViewModelService';
import { getGlobalMessageService } from '../services/globalMessageService';
import { getDisplayPath } from '../utils/pathUtils';
import './ProjectSettingsDialog.css';

// =============================================================================
// 组件接口
// =============================================================================

interface MCPServerInfo {
  name: string;
  status: 'disconnected' | 'connecting' | 'connected';
  toolCount: number;
  error?: string;
  enabled?: boolean; // 是否启用（控制工具是否注册给 AI）
}

interface UserInfo {
  openId: string;
  userId: string;
  name: string;
  enName?: string;
  email?: string;
  avatar?: string;
}

interface YoloModeSettingsDialogProps {
  /** 是否显示对话框 */
  isOpen: boolean;

  /** 关闭对话框回调 */
  onClose: () => void;

  /** MCP 服务器状态列表 */
  mcpServers?: MCPServerInfo[];

  /** MCP 发现状态 */
  mcpDiscoveryState?: 'not_started' | 'in_progress' | 'completed';

  /** 是否已收到 MCP 状态 */
  mcpStatusLoaded?: boolean;

  /** 切换 MCP 启用状态的回调 */
  onToggleMcpEnabled?: (serverName: string, enabled: boolean) => void;

  /** 记忆文件路径列表 */
  memoryFilePaths?: string[];

  /** 记忆文件数量 */
  memoryFileCount?: number;

  /** 当前登录用户信息 */
  userInfo?: UserInfo | null;

  /** 退出登录回调 */
  onLogout?: () => void;
}

type SettingsTab = 'general' | 'mcp' | 'memory' | 'more' | 'account';

// =============================================================================
// 主组件
// =============================================================================

export const YoloModeSettingsDialog: React.FC<YoloModeSettingsDialogProps> = ({
  isOpen,
  onClose,
  mcpServers = [],
  mcpDiscoveryState = 'not_started',
  mcpStatusLoaded = false,
  onToggleMcpEnabled,
  memoryFilePaths = [],
  memoryFileCount = 0,
  userInfo,
  onLogout
}) => {
  const { t } = useTranslation();
  const {
    yoloMode: originalYoloMode,
    preferredModel: originalPreferredModel,
    healthyUse: originalHealthyUse,
    updateYoloMode,
    updatePreferredModel,
    updateHealthyUse,
    loadYoloMode,
    isLoading,
    error
  } = useYoloMode();

  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [isRefreshingMemory, setIsRefreshingMemory] = useState(false);

  // 账户管理状态
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // User Rules 状态
  const [userRules, setUserRules] = useState<string>('');
  const [userRulesOriginal, setUserRulesOriginal] = useState<string>(''); // 原始值，用于检测是否有修改
  const [userRulesSaveStatus, setUserRulesSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveStatusTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 用户规则限制常量
  const MAX_RULES_LINES = 100;
  const MAX_RULES_BYTES = 3000;

  // 计算当前行数（不计算空行）
  const userRulesLineCount = userRules ? userRules.split('\n').filter(line => line.trim()).length : 0;

  // 计算字节数（不计算空格）
  const userRulesNoSpaces = userRules.replace(/\s/g, '');
  const userRulesByteCount = new TextEncoder().encode(userRulesNoSpaces).length;

  // 检查是否超限
  const isOverLineLimit = userRulesLineCount > MAX_RULES_LINES;
  const isOverByteLimit = userRulesByteCount > MAX_RULES_BYTES;
  const isOverLimit = isOverLineLimit || isOverByteLimit;

  // 检查是否有修改
  const hasChanges = userRules !== userRulesOriginal;

  // 是否可以保存
  const canSave = hasChanges && !isOverLimit;

  // 🎯 对话框打开时初始化数据（仅在isOpen改变时触发）
  React.useEffect(() => {
    if (isOpen) {
      console.log('[YOLO] Dialog opened, initializing settings');
      // 加载最新的设置
      loadYoloMode();

      // 获取可用模型
      webviewModelService.getAvailableModels().then(models => {
        setAvailableModels(models);
      }).catch(err => {
        console.error('Failed to load models:', err);
      });

      // 获取用户规则
      getGlobalMessageService().getUserRules();
    }
  }, [isOpen, loadYoloMode]);

  // 🎯 监听用户规则响应
  useEffect(() => {
    const messageService = getGlobalMessageService();

    const unsubscribeRules = messageService.onUserRulesResponse((data) => {
      console.log('[UserRules] Received rules:', data.rules?.length || 0, 'chars');
      setUserRules(data.rules || '');
      setUserRulesOriginal(data.rules || ''); // 保存原始值
    });

    const unsubscribeSaved = messageService.onUserRulesSaved((data) => {
      if (data.success) {
        console.log('[UserRules] Rules saved successfully');
        setUserRulesSaveStatus('saved');
        setUserRulesOriginal(userRules); // 更新原始值
        // 3秒后恢复为 idle
        if (saveStatusTimeoutRef.current) {
          clearTimeout(saveStatusTimeoutRef.current);
        }
        saveStatusTimeoutRef.current = setTimeout(() => {
          setUserRulesSaveStatus('idle');
        }, 3000);
      } else {
        console.error('[UserRules] Failed to save rules:', data.error);
        setUserRulesSaveStatus('error');
        // 3秒后恢复为 idle
        if (saveStatusTimeoutRef.current) {
          clearTimeout(saveStatusTimeoutRef.current);
        }
        saveStatusTimeoutRef.current = setTimeout(() => {
          setUserRulesSaveStatus('idle');
        }, 3000);
      }
    });

    return () => {
      unsubscribeRules();
      unsubscribeSaved();
      if (saveStatusTimeoutRef.current) {
        clearTimeout(saveStatusTimeoutRef.current);
      }
    };
  }, [userRules]);

  // 🎯 用户规则变更处理（不自动保存，需要点击保存按钮）
  const handleUserRulesChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setUserRules(newValue);
    // 重置保存状态
    if (userRulesSaveStatus === 'saved' || userRulesSaveStatus === 'error') {
      setUserRulesSaveStatus('idle');
    }
  }, [userRulesSaveStatus]);

  // 🎯 保存用户规则
  const handleSaveUserRules = useCallback(() => {
    if (!canSave) return;

    console.log('[UserRules] Saving rules...');
    setUserRulesSaveStatus('saving');
    getGlobalMessageService().saveUserRules(userRules);
  }, [canSave, userRules]);

  // =============================================================================
  // 事件处理
  // =============================================================================

  /**
   * 处理YOLO模式改变 - 直接生效
   */
  const handleYoloModeChange = async (enabled: boolean) => {
    console.log('[YOLO] YOLO mode toggle changed, immediately updating:', enabled);
    try {
      await updateYoloMode(enabled);
    } catch (error) {
      console.error('[YOLO] Failed to update YOLO mode:', error);
    }
  };

  /**
   * 处理默认模型改变 - 直接生效
   */
  const handlePreferredModelChange = async (model: string) => {
    console.log('[YOLO] Preferred model changed, immediately updating:', model);
    try {
      await updatePreferredModel(model);
    } catch (error) {
      console.error('[YOLO] Failed to update preferred model:', error);
    }
  };

  /**
   * 处理健康使用提醒改变 - 直接生效
   */
  const handleHealthyUseChange = async (enabled: boolean) => {
    console.log('[HEALTH] Healthy use toggle changed, immediately updating:', enabled);
    try {
      await updateHealthyUse(enabled);
    } catch (error) {
      console.error('[HEALTH] Failed to update healthy use reminder:', error);
    }
  };

  /**
   * 处理关闭对话框
   */
  const handleCancel = () => {
    console.log('[YOLO] Dialog closed');
    onClose();
  };

  /**
   * 处理键盘事件
   */
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      handleCancel();
    }
  };

  /**
   * 打开 MCP 配置文件
   */
  const handleOpenMCPSettings = () => {
    // 发送消息给扩展打开配置文件
    window.vscode?.postMessage({
      type: 'open_mcp_settings',
      payload: {}
    });
  };

  /**
   * 打开记忆文件
   */
  const handleOpenMemoryFile = (filePath: string) => {
    console.log('[Memory] Opening memory file:', filePath);
    getGlobalMessageService().openFile(filePath);
  };

  /**
   * 手动刷新内存文件
   */
  const handleRefreshMemory = async () => {
    setIsRefreshingMemory(true);
    try {
      console.log('[Memory] Manually refreshing memory');
      getGlobalMessageService().refreshMemory();
      // 显示成功提示
      setTimeout(() => {
        setIsRefreshingMemory(false);
      }, 1500);
    } catch (error) {
      console.error('[Memory] Failed to refresh memory:', error);
      setIsRefreshingMemory(false);
    }
  };

  /**
   * 处理退出登录
   */
  const handleLogout = useCallback(() => {
    setShowLogoutConfirm(true);
  }, []);

  /**
   * 确认退出登录
   */
  const handleConfirmLogout = useCallback(() => {
    setShowLogoutConfirm(false);
    setIsLoggingOut(true);
    onLogout?.();
  }, [onLogout]);

  /**
   * 取消退出登录
   */
  const handleCancelLogout = useCallback(() => {
    setShowLogoutConfirm(false);
  }, []);

  // =============================================================================
  // 渲染
  // =============================================================================

  if (!isOpen) return null;

  return (
    <div className="project-settings-dialog__backdrop" onClick={handleCancel}>
      <div
        className="project-settings-dialog yolo-mode-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        {/* 对画框头部 */}
        <div className="project-settings-dialog__header">
          <h2 className="project-settings-dialog__title">
            {t('settings.title')}
          </h2>
          <button
            className="project-settings-dialog__close-btn"
            onClick={handleCancel}
            title={t('settings.close')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z"/>
            </svg>
          </button>
        </div>

        {/* 标签页 + 内容包装器 */}
        <div className="project-settings-dialog__wrapper">
          {/* 标签页导航 */}
          <div className="project-settings-dialog__tabs">
            <button
              className={`project-settings-dialog__tab ${activeTab === 'general' ? 'project-settings-dialog__tab--active' : ''}`}
              onClick={() => setActiveTab('general')}
            >
              {t('settings.tabs.general')}
            </button>
            <button
              className={`project-settings-dialog__tab ${activeTab === 'mcp' ? 'project-settings-dialog__tab--active' : ''}`}
              onClick={() => setActiveTab('mcp')}
            >
              {t('settings.tabs.mcp')}
            </button>
            <button
              className={`project-settings-dialog__tab ${activeTab === 'memory' ? 'project-settings-dialog__tab--active' : ''}`}
              onClick={() => setActiveTab('memory')}
            >
              {t('settings.tabs.memory')}
            </button>
            <button
              className={`project-settings-dialog__tab ${activeTab === 'more' ? 'project-settings-dialog__tab--active' : ''}`}
              onClick={() => setActiveTab('more')}
            >
              {t('settings.tabs.more')}
            </button>
            <button
              className={`project-settings-dialog__tab ${activeTab === 'account' ? 'project-settings-dialog__tab--active' : ''}`}
              onClick={() => setActiveTab('account')}
            >
              {t('settings.tabs.account')}
            </button>
          </div>

          {/* 对话框主体 */}
          <div className="project-settings-dialog__body yolo-mode-body">
          {/* 错误提示 */}
          {error && activeTab === 'general' && (
            <div className="project-settings-dialog__error">
              <svg className="project-settings-dialog__error-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 5.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
              </svg>
              {error}
            </div>
          )}

          {/* 设置面板 */}
          <div className="project-settings-dialog__panel yolo-mode-panel">
            {activeTab === 'general' && (
              <ExecutionSettingsPanel
                yoloMode={originalYoloMode}
                onYoloModeChange={handleYoloModeChange}
                preferredModel={originalPreferredModel}
                onPreferredModelChange={handlePreferredModelChange}
                healthyUse={originalHealthyUse}
                onHealthyUseChange={handleHealthyUseChange}
                availableModels={availableModels}
              />
            )}
            {activeTab === 'mcp' && (
              <MCPSettingsPanel
                mcpServers={mcpServers}
                discoveryState={mcpDiscoveryState}
                statusLoaded={mcpStatusLoaded}
                onOpenSettings={handleOpenMCPSettings}
                onToggleEnabled={onToggleMcpEnabled}
              />
            )}
            {activeTab === 'memory' && (
              <div className="memory-panel">
                {/* 记忆文件部分 */}
                <div className="memory-panel__section">
                  <div className="memory-panel__header">
                    <h3 className="memory-panel__title">
                      {t('settings.memory.title')}
                    </h3>
                    <p className="memory-panel__description">
                      {memoryFileCount > 0
                        ? t('settings.memory.description', { count: memoryFileCount })
                        : t('settings.memory.none')}
                    </p>
                  </div>
                  {memoryFilePaths.length > 0 && (
                    <div className="memory-panel__list-container">
                      <ul className="memory-panel__list">
                        {memoryFilePaths.map((filePath, index) => (
                          <li
                            key={index}
                            className="memory-panel__list-item"
                          >
                            <button
                              onClick={() => handleOpenMemoryFile(filePath)}
                              className="memory-panel__file-button"
                              title={`Click to open: ${filePath}`}
                            >
                              <svg className="memory-panel__file-icon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M10 1H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5l-4-4zm0 2.5V5h2.5L10 3.5z"/>
                              </svg>
                              {getDisplayPath(filePath, 52)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {memoryFileCount > 0 && (
                    <button
                      onClick={handleRefreshMemory}
                      disabled={isRefreshingMemory}
                      className="memory-panel__refresh-button"
                    >
                      <svg className="memory-panel__refresh-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M13 2L11 3.99545L11.0592 4.05474M11 18.0001L13 19.9108L12.9703 19.9417M11.0592 4.05474L13 6M11.0592 4.05474C11.3677 4.01859 11.6817 4 12 4C16.4183 4 20 7.58172 20 12C20 14.5264 18.8289 16.7793 17 18.2454M7 5.75463C5.17107 7.22075 4 9.47362 4 12C4 16.4183 7.58172 20 12 20C12.3284 20 12.6523 19.9802 12.9703 19.9417M11 22.0001L12.9703 19.9417"/>
                      </svg>
                      {isRefreshingMemory ? t('settings.memory.refreshing') : t('settings.memory.refresh')}
                    </button>
                  )}
                </div>

                {/* 分隔线 */}
                <div className="memory-panel__divider" />

                {/* 用户规则部分 */}
                <div className="memory-panel__section">
                  <div className="memory-panel__header">
                    <h3 className="memory-panel__title">
                      {t('settings.userRules.title')}
                    </h3>
                    <p className="memory-panel__description">
                      {t('settings.userRules.description')}
                    </p>
                  </div>
                  <div className="memory-panel__rules-container">
                    <textarea
                      className={`memory-panel__rules-textarea ${isOverLineLimit ? 'memory-panel__rules-textarea--error' : ''}`}
                      value={userRules}
                      onChange={handleUserRulesChange}
                      placeholder={t('settings.userRules.placeholder')}
                      rows={6}
                    />
                    <div className="memory-panel__rules-footer">
                      <div className="memory-panel__rules-stats">
                        <span className={`memory-panel__line-count ${isOverLineLimit ? 'memory-panel__line-count--error' : ''}`}>
                          {t('settings.userRules.lineCount', { current: userRulesLineCount, max: MAX_RULES_LINES })}
                        </span>
                        <span className={`memory-panel__byte-count ${isOverByteLimit ? 'memory-panel__byte-count--error' : ''}`}>
                          {t('settings.userRules.byteCount', { current: userRulesByteCount, max: MAX_RULES_BYTES })}
                        </span>
                      </div>
                      <div className="memory-panel__rules-actions">
                        {isOverLimit && (
                          <span className="memory-panel__limit-error">
                            {isOverLineLimit ? t('settings.userRules.lineLimitExceeded') : t('settings.userRules.byteLimitExceeded')}
                          </span>
                        )}
                        <span className={`memory-panel__save-status memory-panel__save-status--${userRulesSaveStatus}`}>
                          {userRulesSaveStatus === 'saving' && t('settings.userRules.saving')}
                          {userRulesSaveStatus === 'saved' && (
                            <>
                              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                                <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/>
                              </svg>
                              {t('settings.userRules.saved')}
                            </>
                          )}
                          {userRulesSaveStatus === 'error' && (
                            <span className="memory-panel__save-error">{t('settings.userRules.saveFailed')}</span>
                          )}
                        </span>
                        <button
                          className={`memory-panel__save-button ${!canSave ? 'memory-panel__save-button--disabled' : ''}`}
                          onClick={handleSaveUserRules}
                          disabled={!canSave}
                          title={!hasChanges ? t('settings.userRules.noChanges') : isOverLimit ? t('settings.userRules.limitExceeded') : t('settings.userRules.save')}
                        >
                          {t('settings.userRules.save')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {activeTab === 'more' && (
              <div className="more-panel">
                <div className="more-panel__section">
                  <h3 className="more-panel__title">{t('settings.more.title')}</h3>
                  <p className="more-panel__description">
                    {t('settings.more.description')}
                  </p>
                  <button
                    className="more-panel__button"
                    onClick={() => {
                      getGlobalMessageService().openExtensionSettings();
                    }}
                    title={t('settings.more.open')}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M22 6.5H16" stroke="currentColor" strokeWidth="1.5" strokeMiterlimit="10" strokeLinecap="round" strokeLinejoin="round"/>
                      <g opacity="0.4">
                        <path d="M6 6.5H2" stroke="currentColor" strokeWidth="1.5" strokeMiterlimit="10" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M10 10C11.933 10 13.5 8.433 13.5 6.5C13.5 4.567 11.933 3 10 3C8.067 3 6.5 4.567 6.5 6.5C6.5 8.433 8.067 10 10 10Z" stroke="currentColor" strokeWidth="1.5" strokeMiterlimit="10" strokeLinecap="round" strokeLinejoin="round"/>
                      </g>
                      <path d="M8 17.5H2" stroke="currentColor" strokeWidth="1.5" strokeMiterlimit="10" strokeLinecap="round" strokeLinejoin="round"/>
                      <g opacity="0.4">
                        <path d="M22 17.5H18" stroke="currentColor" strokeWidth="1.5" strokeMiterlimit="10" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M14 21C15.933 21 17.5 19.433 17.5 17.5C17.5 15.567 15.933 14 14 14C12.067 14 10.5 15.567 10.5 17.5C10.5 19.433 12.067 21 14 21Z" stroke="currentColor" strokeWidth="1.5" strokeMiterlimit="10" strokeLinecap="round" strokeLinejoin="round"/>
                      </g>
                    </svg>
                    {t('settings.more.open')}
                  </button>
                </div>
              </div>
            )}
            {activeTab === 'account' && (
              <div className="account-panel">
                <div className="account-panel__section">
                  <h3 className="account-panel__title">{t('settings.account.title')}</h3>
                  {userInfo ? (
                    <div className="account-panel__info">
                      {/* 用户名称 */}
                      <div className="account-panel__name-group">
                        <span className="account-panel__display-name">{userInfo.name}</span>
                        {userInfo.enName && userInfo.enName !== userInfo.name && (
                          <span className="account-panel__en-name">{userInfo.enName}</span>
                        )}
                      </div>

                      {/* 用户详情 */}
                      <div className="account-panel__details">
                        {userInfo.email && (
                          <div className="account-panel__detail-row">
                            <span className="account-panel__detail-label">{t('settings.account.email')}</span>
                            <span className="account-panel__detail-value">{userInfo.email}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="account-panel__not-logged-in">{t('settings.account.notLoggedIn')}</p>
                  )}

                  {/* 退出登录按钮 */}
                  {userInfo && (
                    <div className="account-panel__actions">
                      {!showLogoutConfirm ? (
                        <button
                          className="account-panel__logout-btn"
                          onClick={handleLogout}
                          disabled={isLoggingOut}
                        >
                          {isLoggingOut ? (
                            <>
                              <span className="account-panel__spinner"></span>
                              {t('settings.account.loggingOut')}
                            </>
                          ) : (
                            <>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                                <polyline points="16 17 21 12 16 7" />
                                <line x1="21" y1="12" x2="9" y2="12" />
                              </svg>
                              {t('settings.account.logoutButton')}
                            </>
                          )}
                        </button>
                      ) : (
                        <div className="account-panel__logout-confirm">
                          <p className="account-panel__logout-confirm-text">
                            {t('settings.account.logoutConfirm')}
                          </p>
                          <div className="account-panel__logout-confirm-actions">
                            <button
                              className="account-panel__logout-confirm-btn account-panel__logout-confirm-btn--cancel"
                              onClick={handleCancelLogout}
                            >
                              {t('settings.close')}
                            </button>
                            <button
                              className="account-panel__logout-confirm-btn account-panel__logout-confirm-btn--confirm"
                              onClick={handleConfirmLogout}
                            >
                              {t('settings.account.logoutButton')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
        </div>


      </div>
    </div>
  );
};

// =============================================================================
// 兼容性导出
// =============================================================================

/** @deprecated 使用 YoloModeSettingsDialog 替代 */
export const ProjectSettingsDialog = YoloModeSettingsDialog;