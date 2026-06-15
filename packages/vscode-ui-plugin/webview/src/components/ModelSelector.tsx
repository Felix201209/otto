/**
 * Model Selector Component - 模型选择器组件
 * 提供类似于图片中显示的模型选择下拉菜单
 * 从服务端API获取模型数据，支持缓存和配置持久化
 */

import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { ChevronDown, Check, Loader2, BarChart2, Brain, Plus, X } from 'lucide-react';
import { useTranslation } from '../hooks/useTranslation';
import { webviewModelService } from '../services/webViewModelService';
import { getGlobalMessageService } from '../services/globalMessageService';
import { customModelsService } from '../services/customModelsService';
import { getProviderIcon } from './ModelProviderIcons';
import { SessionStatisticsDialog } from './SessionStatisticsDialog';
import { CustomModelWizard } from './CustomModelWizard';
import { ChatMessage } from '../types';
import { useYoloMode } from '../hooks/useProjectSettings';
import './ModelSelector.css';
import './ModelProviderIcons.css';

// 模型信息接口（匹配服务端API）
export interface ModelInfo {
  name: string;
  displayName: string;
  creditsPerRequest: number;
  available: boolean;
  maxToken: number;
  highVolumeThreshold: number;
  highVolumeCredits: number;
}

// 模型类型定义（用于UI显示）
interface ModelOption {
  id: string;
  name: string;
  displayName: string;
  category: 'claude' | 'gemini' | 'kimi' | 'gpt' | 'qwen' | 'grok' | 'auto' | 'minimax' | 'custom';
  creditsPerRequest: number | undefined;
  maxToken: number;
  description?: string;
  isAvailable: boolean;
  highVolumeCredits?: number;
  highVolumeThreshold?: number;
}

// 根据模型名称推断类别
const inferCategory = (modelName: string): ModelOption['category'] => {
  if (modelName === 'auto') return 'auto';
  // 🟢 自定义模型一律以 `custom:` 前缀识别，
  // 与 core 侧 isCustomModel() 判定一致。
  if (modelName.startsWith('custom:')) return 'custom';
  if (modelName.includes('claude')) return 'claude';
  if (modelName.includes('gemini')) return 'gemini';
  if (modelName.includes('kimi')) return 'kimi';
  if (modelName.includes('gpt')) return 'gpt';
  if (modelName.includes('qwen')) return 'qwen';
  if (modelName.includes('grok')) return 'grok';
  if (modelName.includes('minimax')) return 'minimax';
  return 'gemini'; // 默认
};

/**
 * 自定义模型 [Provider] 徽章描述。
 * - label: 显示在模型名前面的方括号短标签（与 CLI Wizard 的 PROTO_LABEL 对齐）
 * - cssVar: 用 VSCode 主题变量给徽章配色，方便明暗主题自适应
 *
 * Provider 字符串来自 ~/.deepv/custom-models.json，可能取值：
 *   'openai' | 'openai-responses' | 'anthropic' | 'gemini'
 * 任何未知值落到 'Custom' / fg 默认色（最大鲁棒性）。
 */
const CUSTOM_PROVIDER_BADGES: Record<string, { label: string; cssVar: string }> = {
  openai: { label: 'OpenAI Chat', cssVar: 'var(--vscode-terminal-ansiGreen)' },
  'openai-responses': { label: 'OpenAI Responses', cssVar: 'var(--vscode-terminal-ansiBrightGreen, var(--vscode-terminal-ansiGreen))' },
  anthropic: { label: 'Anthropic', cssVar: 'var(--vscode-terminal-ansiYellow)' },
  gemini: { label: 'Gemini', cssVar: 'var(--vscode-terminal-ansiBlue)' },
};

function getCustomBadge(provider?: string): { label: string; cssVar: string } {
  if (!provider) return { label: 'Custom', cssVar: 'var(--vscode-textLink-foreground)' };
  return CUSTOM_PROVIDER_BADGES[provider] || { label: 'Custom', cssVar: 'var(--vscode-textLink-foreground)' };
}

// 将ModelInfo转换为ModelOption
const convertToModelOption = (model: ModelInfo, t: any): ModelOption => ({
  id: model.name,
  name: model.name,
  displayName: model.displayName,
  category: inferCategory(model.name),
  creditsPerRequest: model.creditsPerRequest,
  maxToken: model.maxToken,
  description: t(`model.descriptions.${model.name}`, model.displayName),
  isAvailable: model.available,
  highVolumeCredits: model.highVolumeCredits,
  highVolumeThreshold: model.highVolumeThreshold
});

// 🧠 动态高保真科技感 SVG 脑部图标，根据思考深度（effort / mode）改变色彩和饱和度
const BrainIcon: React.FC<{ level: string; size?: number }> = ({ level, size = 14 }) => {
  const isDark = document.body.classList.contains('vscode-dark') ||
                 document.body.classList.contains('vscode-high-contrast');

  let color = 'gray';
  let opacity = 0.8;

  if (isDark) {
    switch (level) {
      case 'off':
        color = 'var(--vscode-disabledForeground, #444444)';
        opacity = 0.35;
        break;
      case 'auto':
        color = '#cccccc';
        opacity = 0.85;
        break;
      case 'low':
        color = '#888888';
        opacity = 0.65;
        break;
      case 'medium':
        color = '#bbbbbb';
        opacity = 0.8;
        break;
      case 'high':
      case 'on':
        color = '#eeeeee';
        opacity = 0.95;
        break;
      case 'max':
        color = '#ffffff';
        opacity = 1.0;
        break;
      default:
        color = '#cccccc';
        opacity = 0.85;
    }
  } else {
    // Light Theme
    switch (level) {
      case 'off':
        color = 'var(--vscode-disabledForeground, #cccccc)';
        opacity = 0.35;
        break;
      case 'auto':
        color = '#444444';
        opacity = 0.85;
        break;
      case 'low':
        color = '#999999';
        opacity = 0.65;
        break;
      case 'medium':
        color = '#666666';
        opacity = 0.8;
        break;
      case 'high':
      case 'on':
        color = '#333333';
        opacity = 0.95;
        break;
      case 'max':
        color = '#000000';
        opacity = 1.0;
        break;
      default:
        color = '#444444';
        opacity = 0.85;
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'inline-block', verticalAlign: 'middle', transition: 'fill 0.3s ease' }}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.7086 1.53214C10.9786 1.05676 10.078 0.917375 9.27255 1.04467C8.46803 1.17183 7.62325 1.5904 7.12591 2.39445C6.9332 2.70601 6.81024 3.04646 6.7559 3.40767C5.97312 3.35525 5.18086 3.59264 4.58547 4.08919C3.98255 4.59201 3.59741 5.34432 3.59741 6.25684C3.59741 6.55614 3.63851 6.86315 3.72008 7.17654C3.42298 7.23942 3.13697 7.34918 2.86932 7.50027C1.98542 7.99927 1.36438 8.90663 1.11913 9.88841C0.869371 10.8882 0.989124 12.0467 1.70052 13.0391C2.0609 13.5419 2.54903 13.9691 3.1623 14.305C3.01053 14.5081 2.88229 14.7271 2.77811 14.9565C2.35249 15.8935 2.32044 17.0038 2.64559 17.98C2.97535 18.9701 3.69756 19.8871 4.83624 20.3254C5.57833 20.6111 6.42615 20.6665 7.35551 20.4749C7.39798 20.9494 7.52745 21.3806 7.74983 21.7577C8.22598 22.5651 9.0236 22.9458 9.80541 22.9947C10.5523 23.0414 11.3758 22.778 12 22.2458C12.6242 22.778 13.4477 23.0414 14.1946 22.9947C14.9764 22.9458 15.774 22.5651 16.2502 21.7577C16.4725 21.3806 16.602 20.9494 16.6445 20.4749C17.5738 20.6665 18.4217 20.6111 19.1638 20.3254C20.3024 19.8871 21.0246 18.9701 21.3544 17.98C21.6796 17.0038 21.6475 15.8935 21.2219 14.9565C21.1177 14.7271 20.9895 14.5081 20.8377 14.305C21.451 13.9691 21.9391 13.5419 22.2995 13.0391C23.0109 12.0467 23.1306 10.8882 22.8809 9.88841C22.6356 8.90663 22.0146 7.99927 21.1307 7.50027C20.863 7.34918 20.577 7.23942 20.2799 7.17654C20.3615 6.86315 20.4026 6.55614 20.4026 6.25684C20.4026 5.34432 20.0175 4.59201 19.4145 4.08919C18.8191 3.59264 18.0269 3.35525 17.2441 3.40767C17.1898 3.04646 17.0668 2.70601 16.8741 2.39445C16.3767 1.5904 15.532 1.17183 14.7274 1.04467C13.922 0.917375 13.0214 1.05676 12.2914 1.53214C11.9861 1.73097 12.0139 1.73097 11.7086 1.53214ZM13.0033 20.0518L13.0033 17.5288C13.0045 17.0494 13.1133 16.3457 13.3939 15.7998C13.6573 15.2872 13.9946 15.0268 14.5082 15.0268C15.0623 15.0268 15.5115 14.5773 15.5115 14.0227C15.5115 13.4682 15.0623 13.0186 14.5082 13.0186C13.9202 13.0186 13.4216 13.16 13.0033 13.3894V12.5084C13.0045 12.029 13.1133 11.3254 13.3939 10.7794C13.6573 10.2668 13.9946 10.0064 14.5082 10.0064C15.0623 10.0064 15.5115 9.55688 15.5115 9.00234C15.5115 8.4478 15.0623 7.99826 14.5082 7.99826C13.9202 7.99826 13.4216 8.13957 13.0033 8.36902L13.0033 3.97532C13.005 3.57853 13.1671 3.35779 13.3859 3.21528C13.6436 3.04746 14.0284 2.96723 14.4144 3.02824C14.8013 3.08939 15.0539 3.26704 15.1679 3.45142C15.2603 3.60078 15.3726 3.9329 15.091 4.59054C14.9015 5.03294 15.0524 5.54766 15.4507 5.8175C15.849 6.08734 16.3825 6.03639 16.7226 5.69604C17.0903 5.32811 17.7563 5.32032 18.1299 5.63189C18.2795 5.75662 18.396 5.94564 18.396 6.25684C18.396 6.59422 18.2548 7.14633 17.705 7.91672C17.4235 8.31116 17.4637 8.85055 17.8006 9.19878C18.1375 9.54701 18.6749 9.60465 19.0779 9.33577C19.5101 9.04741 19.8566 9.08664 20.1448 9.24934C20.4837 9.44063 20.8032 9.85112 20.9342 10.3755C21.0607 10.8818 20.9923 11.4176 20.669 11.8686C20.3466 12.3184 19.6765 12.8121 18.3565 13.0323C17.8683 13.1137 17.5124 13.5392 17.5182 14.0344C17.5239 14.5296 17.8896 14.9467 18.3795 15.0167C18.8812 15.0884 19.207 15.3732 19.3952 15.7874C19.5966 16.231 19.6273 16.8151 19.4508 17.345C19.2789 17.861 18.9351 18.2619 18.4434 18.4511C17.9498 18.6411 17.1399 18.6809 15.9267 18.129C15.5761 17.9695 15.1653 18.025 14.8694 18.2716C14.5735 18.5183 14.4448 18.9127 14.5382 19.2866C14.6621 19.7827 14.8668 20.9406 14.0694 20.9905C13.5184 21.0249 13.0062 20.6055 13.0033 20.0518ZM10.9967 3.97532C10.995 3.57853 10.8329 3.35779 10.6141 3.21528C10.3564 3.04746 9.97157 2.96723 9.58558 3.02824C9.19869 3.08939 8.94611 3.26704 8.83207 3.45142C8.73968 3.60078 8.62739 3.9329 8.90901 4.59054C9.09846 5.03294 8.94757 5.54766 8.54931 5.8175C8.15105 6.08734 7.61747 6.03639 7.27739 5.69604C6.90975 5.32811 6.24365 5.32032 5.87006 5.63189C5.72051 5.75662 5.604 5.94564 5.604 6.25684C5.604 6.59422 5.74515 7.14633 6.29501 7.91672C6.57653 8.31116 6.53629 8.85055 6.19937 9.19878C5.86246 9.54701 5.32505 9.60465 4.92206 9.33577C4.48987 9.04741 4.1434 9.08664 3.8552 9.24934C3.51634 9.44063 3.19679 9.85112 3.06581 10.3755C2.93933 10.8818 3.0077 11.4176 3.33095 11.8686C3.65342 12.3184 4.32349 12.8121 5.64353 13.0323C6.13166 13.1137 6.48757 13.5392 6.48182 14.0344C6.47607 14.5296 6.11037 14.9467 5.62048 15.0167C5.1188 15.0884 4.793 15.3732 4.60484 15.7874C4.40339 16.231 4.37273 16.8151 4.54922 17.345C4.7211 17.861 5.06489 18.2619 5.55656 18.4511C6.05021 18.6411 6.86015 18.6809 8.0733 18.129C8.42388 17.9695 8.83474 18.025 9.13063 18.2716C9.42652 18.5183 9.5552 18.9127 9.4618 19.2866C9.33788 19.7827 9.13324 20.9406 9.93058 20.9905C10.4816 21.0249 10.9938 20.6055 10.9967 20.0518L10.9967 20.0472V17.5292C10.9955 17.0498 10.8868 16.3459 10.6061 15.7998C10.3427 15.2872 10.0054 15.0268 9.49176 15.0268C8.93765 15.0268 8.48846 14.5773 8.48846 14.0227C8.48846 13.4682 8.93765 13.0186 9.49176 13.0186C10.0798 13.0186 10.5784 13.16 10.9967 13.3894V12.5088C10.9955 12.0294 10.8868 11.3255 10.6061 10.7794C10.3427 10.2668 10.0054 10.0064 9.49176 10.0064C8.93765 10.0064 8.48846 9.55688 8.48846 9.00234C8.48846 8.4478 8.93765 7.99826 9.49176 7.99826C10.0798 7.99826 10.5784 8.13957 10.9967 8.36902L10.9967 3.97532Z"
        fill={color}
      />
    </svg>
  );
};

interface ModelSelectorProps {
  selectedModelId?: string;
  onModelChange?: (modelId: string, model: ModelOption) => void;
  disabled?: boolean;
  className?: string;
  sessionId?: string; // 🎯 新增：当前会话ID
  isSwitchingFromParent?: boolean; // 🎯 新增：从父组件传入的切换状态
  messages?: ChatMessage[]; // 🎯 新增：用于统计
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  selectedModelId = 'auto',
  onModelChange,
  disabled = false,
  className = '',
  sessionId,
  isSwitchingFromParent = false,
  messages = []
}) => {
  const { t } = useTranslation();
  const { thinkingConfig, updateThinkingConfig } = useYoloMode();
  const [isOpen, setIsOpen] = useState(false);
  const [isThinkingOpen, setIsThinkingOpen] = useState(false); // 🆕 思考模式下拉状态
  const [isStatsOpen, setIsStatsOpen] = useState(false); // 🎯 统计对话框状态
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const [isSwitchingLocal, setIsSwitchingLocal] = useState(false); // 🎯 本地切换状态

  // 🟢 自定义模型向导：webview 直接 mount，不依赖登录状态
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  // 🟢 用于在 wizard 完成 / extension 广播 custom_models_changed 时强制刷新模型列表
  const [modelListRefreshTick, setModelListRefreshTick] = useState(0);

  // 🟢 Provider 信息缓存：modelService 透传给 ModelSelector 的 ModelInfo 不带
  // provider 字段（保持向后兼容），所以单独从 storage 拉一份用于渲染前缀。
  // listCustomModels 通过 IPC 一次拿全，每次刷新 tick 时也同步刷新一次。
  const [customProviderMap, setCustomProviderMap] = useState<Record<string, string>>({});

  // 🎯 最终切换状态：本地或父组件
  const isSwitching = isSwitchingLocal || isSwitchingFromParent;

  const dropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null); // 🆕 思考模式下拉容器
  const containerRef = useRef<HTMLDivElement>(null);

  // 🆕 监听点击外部关闭思考下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(event.target as Node)) {
        setIsThinkingOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 🎯 Tooltip 状态管理
  const [showTooltip, setShowTooltip] = useState<{ [key: string]: boolean }>({});
  const [tooltipPosition, setTooltipPosition] = useState<{ [key: string]: { top: number; left: number } }>({});
  const modelNameRefs = useRef<{ [key: string]: HTMLSpanElement | null }>({});
  const debounceTimerRef = useRef<{ [key: string]: NodeJS.Timeout }>({});

  // 获取可用模型列表（带指数退避重试）
  useEffect(() => {
    const MAX_RETRIES = 3;
    const BASE_DELAY = 500; // 500ms, 1000ms, 2000ms

    const fetchModelsWithRetry = async (retryCount = 0): Promise<void> => {
      try {
        if (retryCount === 0) {
          setLoading(true);
          setError(null);
        }

        // 并行获取可用模型和当前模型（传递sessionId）
        const [models, currentModelName] = await Promise.all([
          webviewModelService.getAvailableModels(),
          webviewModelService.getCurrentModel(sessionId)
        ]);

        // 转换为UI所需的ModelOption格式
        const options = models.map(model => convertToModelOption(model, t));
        setModelOptions(options);

        // 设置当前选中模型（优先使用服务端返回的当前模型）
        const selectedModelName = currentModelName || selectedModelId;
        const currentModel = options.find(opt => opt.id === selectedModelName) || options[0];
        if (currentModel) {
          setSelectedModel(currentModel);
        }

        setLoading(false);
      } catch (err) {
        console.error(`Failed to fetch models (attempt ${retryCount + 1}/${MAX_RETRIES}):`, err);

        // 🎯 指数退避重试
        if (retryCount < MAX_RETRIES - 1) {
          const delay = BASE_DELAY * Math.pow(2, retryCount);
          console.log(`[ModelSelector] Retrying in ${delay}ms...`);
          setTimeout(() => {
            fetchModelsWithRetry(retryCount + 1);
          }, delay);
          return;
        }

        // 所有重试都失败了，显示错误并降级到默认模型
        console.error('[ModelSelector] All retries failed, using fallback model');
        setError(err instanceof Error ? err.message : 'Unknown error');

        // 降级到默认模型
        const fallbackModel: ModelOption = {
          id: 'auto',
          name: 'auto',
          displayName: 'Auto',
          category: 'auto',
          creditsPerRequest: undefined,
          maxToken: 200000,
          isAvailable: true
        };
        setModelOptions([fallbackModel]);
        setSelectedModel(fallbackModel);
        setLoading(false);
      }
    };

    fetchModelsWithRetry();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, t, modelListRefreshTick]); // 🟢 当向导保存或 extension 广播变化时，重新拉一次列表

  // 🎯 响应外部 selectedModelId 变化（如压缩后模型切换）
  useEffect(() => {
    // 🎯 如果正在手动切换中，忽略外部属性同步，避免被旧属性值冲掉状态
    if (isSwitchingLocal) return;

    if (selectedModelId && modelOptions.length > 0) {
      const newModel = modelOptions.find(opt => opt.id === selectedModelId);
      if (newModel && newModel.id !== selectedModel?.id) {
        console.log('📊 [ModelSelector] Updating selectedModel from prop:', selectedModelId);
        setSelectedModel(newModel);
      }
    }
  }, [selectedModelId, modelOptions, selectedModel?.id, isSwitchingLocal]);

  // 🎯 监听模型切换完成消息
  useEffect(() => {
    const messageService = getGlobalMessageService();
    const cleanup = messageService.onExtensionMessage('model_switch_complete', () => {
      console.log('📊 [ModelSelector] Received model_switch_complete, clearing isSwitchingLocal');
      setIsSwitchingLocal(false);
    });

    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  // 🟢 监听 extension 广播的 custom_models_changed —— 任何 webview 添加/删除自定义
  // 模型后所有打开的 ModelSelector 都即时刷新一次。
  useEffect(() => {
    const unsubscribe = customModelsService.onModelsChanged((models) => {
      // 同时更新本地 provider 映射，避免 ModelInfo 丢失 provider 信息后
      // 选项渲染时取不到 [Provider] 前缀。
      const map: Record<string, string> = {};
      for (const m of models || []) {
        if (m && m.displayName && m.provider) {
          map[`custom:${m.displayName}`] = m.provider;
        }
      }
      setCustomProviderMap(map);
      setModelListRefreshTick((prev) => prev + 1);
    });
    return unsubscribe;
  }, []);

  // 🟢 Provider 信息缓存初始化 + 跟随 tick 刷新。
  // 主要处理初载场景；extension 广播路径中的同步在上一个 useEffect 里。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const models = await customModelsService.listCustomModels();
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const m of models) {
          if (m?.displayName && m?.provider) {
            map[`custom:${m.displayName}`] = m.provider;
          }
        }
        setCustomProviderMap(map);
      } catch {
        // best-effort — 没拿到就不显示前缀
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelListRefreshTick]);

  /**
   * 删除自定义模型。点 X → 原生 confirm → IPC 删除。
   * 删除后 extension 端会广播 custom_models_changed，列表自动刷新。
   * 如果当前选中的就是被删的模型，由 extension 端的 setCustomModels 热重载会
   * 把 session 模型回退到默认；这里只关心 UI 刷新，不主动切换。
   */
  const handleDeleteCustomModel = useCallback(
    async (e: React.MouseEvent, modelId: string, displayName: string) => {
      e.stopPropagation();
      e.preventDefault();
      // 用 window.confirm 是 webview 里最简单可靠的确认方式，
      // 不需要再做一个 dialog 组件。
      const ok = window.confirm(
        `Delete custom model "${displayName}"?\n\nThis removes it from ~/.deepv/custom-models.json. The change is shared with the CLI.`,
      );
      if (!ok) return;
      try {
        await customModelsService.deleteCustomModel(modelId);
        // 广播会自动触发刷新，无需手动 setModelListRefreshTick。
      } catch (err) {
        console.error('[ModelSelector] Failed to delete custom model:', err);
        window.alert(
          `Failed to delete model: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [],
  );

  // 点击外部关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // 处理模型选择
  const handleModelSelect = async (model: ModelOption) => {
    if (!model.isAvailable || disabled || isSwitching) return;

    setIsSwitchingLocal(true); // 🎯 开始切换
    setSelectedModel(model);
    setIsOpen(false);

    // 🎯 增加安全超时保护，防止界面永久卡死
    const safetyTimeout = setTimeout(() => {
      setIsSwitchingLocal(current => {
        if (current) {
          console.warn('⚠️ [ModelSelector] Switch timeout safety triggered');
          return false;
        }
        return current;
      });
    }, 10000);

    // 保存模型选择到扩展配置（传递sessionId）
    let success = false;
    try {
      await webviewModelService.setCurrentModel(model.name, sessionId);
      // 🎯 成功后立即清除状态
      setIsSwitchingLocal(false);
      clearTimeout(safetyTimeout);
      success = true;
    } catch (err) {
      console.error('Failed to save model selection:', err);
      setIsSwitchingLocal(false); // 失败时恢复
      clearTimeout(safetyTimeout);
      success = false;
    }

    // 🎯 只有成功才调用 onModelChange 回调，避免失败时重复尝试
    if (success && onModelChange) {
      onModelChange(model.id, model);
    }
  };

  // 获取模型类别显示样式和图标
  const getCategoryInfo = (category: string) => {
    switch (category) {
      case 'auto':
        return {
          icon: getProviderIcon('auto', 16),
          color: 'var(--vscode-terminal-ansiGreen)',
          name: 'Auto'
        };
      case 'claude':
        return {
          icon: getProviderIcon('claude', 16),
          color: 'var(--vscode-terminal-ansiMagenta)',
          name: 'Claude'
        };
      case 'gemini':
        return {
          icon: getProviderIcon('gemini', 16),
          color: 'var(--vscode-terminal-ansiBlue)',
          name: 'Gemini'
        };
      case 'gpt':
        return {
          icon: getProviderIcon('gpt', 16),
          color: 'var(--vscode-terminal-ansiGreen)',
          name: 'GPT'
        };
      case 'kimi':
        return {
          icon: getProviderIcon('kimi', 16),
          color: 'var(--vscode-terminal-ansiCyan)',
          name: 'Kimi'
        };
      case 'qwen':
        return {
          icon: getProviderIcon('qwen', 16),
          color: 'var(--vscode-terminal-ansiYellow)',
          name: 'Qwen'
        };
      case 'grok':
        return {
          icon: getProviderIcon('grok', 16),
          color: 'var(--vscode-terminal-ansiRed)',
          name: 'Grok'
        };
      case 'minimax':
        return {
          icon: getProviderIcon('minimax', 16),
          color: 'var(--vscode-terminal-ansiMagenta)',
          name: 'Minimax'
        };
      case 'custom':
        // 🟢 自定义模型 — 用 default provider 图标 + 强调色，让用户一眼就能区分。
        return {
          icon: getProviderIcon('default', 16),
          color: 'var(--vscode-textLink-foreground)',
          name: 'Custom'
        };
      default:
        return {
          icon: getProviderIcon('default', 16),
          color: 'var(--vscode-foreground)',
          name: 'Model'
        };
    }
  };

  // 🎯 检测文本是否被截断（增强跨平台兼容性）
  // 注意：由于 CSS text-overflow: ellipsis 的特性，这个函数可能检测不准确
  // 目前已改为直接显示 tooltip，不依赖此检测
  const isTextTruncated = (element: HTMLElement | null): boolean => {
    if (!element) return false;

    // 🎯 Windows 兼容性：考虑亚像素渲染和 DPI 缩放
    // 在高 DPI 屏幕上，scrollWidth 和 clientWidth 可能有微小差异
    const threshold = 2; // 容差阈值，考虑亚像素渲染
    const scrollWidth = Math.ceil(element.scrollWidth);
    const clientWidth = Math.floor(element.clientWidth);

    return scrollWidth > clientWidth + threshold;
  };

  // 🎯 获取设备像素比率（Windows DPI 缩放支持）
  const getDevicePixelRatio = (): number => {
    return window.devicePixelRatio || 1;
  };

  // 🎯 获取滚动条宽度（Windows 和 Mac 滚动条处理不同）
  const getScrollbarWidth = (): number => {
    // 创建一个临时的div来测量滚动条宽度
    const outer = document.createElement('div');
    outer.style.visibility = 'hidden';
    outer.style.overflow = 'scroll';
    outer.style.width = '100px';
    outer.style.position = 'absolute';
    outer.style.top = '-9999px';
    document.body.appendChild(outer);

    const inner = document.createElement('div');
    inner.style.width = '100%';
    outer.appendChild(inner);

    const scrollbarWidth = outer.offsetWidth - inner.offsetWidth;
    document.body.removeChild(outer);

    return scrollbarWidth;
  };

  // 🎯 处理鼠标悬停 - 显示 tooltip（增强跨平台兼容性）
  const handleMouseEnter = (modelId: string) => {
    // 清除之前的防抖定时器
    if (debounceTimerRef.current[modelId]) {
      clearTimeout(debounceTimerRef.current[modelId]);
    }

    // 🎯 防抖处理：延迟 150ms 显示 tooltip，避免快速滑过时闪烁
    debounceTimerRef.current[modelId] = setTimeout(() => {
      const element = modelNameRefs.current[modelId];

      // 🎯 简化逻辑：直接显示 tooltip，不检测是否截断
      // 这样可以避免 CSS text-overflow 导致的检测不准确问题
      if (!element) return;

      // 🎯 Windows DPI 缩放支持：获取实际的设备像素比率
      const dpr = getDevicePixelRatio();
      const scrollbarWidth = getScrollbarWidth();

      // 计算tooltip的位置
      const rect = element.getBoundingClientRect();

      // 🎯 考虑 DPI 缩放的位置计算
      let tooltipTop = rect.top - 40; // tooltip高度 + 间距
      let tooltipLeft = rect.left + rect.width / 2 + 20; // 🎯 往右偏移20px

      // 🎯 边界检测：确保tooltip不会超出视口（考虑滚动条宽度）
      const viewportWidth = window.innerWidth - scrollbarWidth;
      const viewportHeight = window.innerHeight;
      const tooltipPadding = 10; // 离边界的最小距离
      const estimatedTooltipWidth = 250; // 预估 tooltip 最大宽度

      // 防止tooltip超出顶部
      if (tooltipTop < tooltipPadding) {
        tooltipTop = rect.bottom + 8; // 显示在元素下方
      }

      // 🎯 防止tooltip超出右边界（考虑 Windows 滚动条）
      if (tooltipLeft + estimatedTooltipWidth / 2 > viewportWidth - tooltipPadding) {
        tooltipLeft = viewportWidth - estimatedTooltipWidth / 2 - tooltipPadding;
      }

      // 🎯 防止tooltip超出左边界
      if (tooltipLeft - estimatedTooltipWidth / 2 < tooltipPadding) {
        tooltipLeft = estimatedTooltipWidth / 2 + tooltipPadding;
      }

      // 🎯 Windows 高DPI适配：确保像素对齐，避免模糊
      tooltipTop = Math.round(tooltipTop * dpr) / dpr;
      tooltipLeft = Math.round(tooltipLeft * dpr) / dpr;

      setTooltipPosition(prev => ({
        ...prev,
        [modelId]: { top: tooltipTop, left: tooltipLeft }
      }));
      setShowTooltip(prev => ({ ...prev, [modelId]: true }));
    }, 150); // 150ms 防抖延迟
  };

  // 🎯 处理鼠标离开 - 隐藏 tooltip（清理防抖定时器）
  const handleMouseLeave = (modelId: string) => {
    // 🎯 清除防抖定时器，避免内存泄漏
    if (debounceTimerRef.current[modelId]) {
      clearTimeout(debounceTimerRef.current[modelId]);
      delete debounceTimerRef.current[modelId];
    }
    setShowTooltip(prev => ({ ...prev, [modelId]: false }));
  };

  // 🎯 监听滚动和窗口大小变化，及时隐藏tooltip（增加防抖优化）
  useEffect(() => {
    let scrollTimer: NodeJS.Timeout | null = null;
    let resizeTimer: NodeJS.Timeout | null = null;

    // 🎯 滚动事件防抖处理（Windows 滚动事件触发频率可能不同）
    const handleScroll = () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        setShowTooltip({});
        // 清除所有防抖定时器
        Object.keys(debounceTimerRef.current).forEach(key => {
          if (debounceTimerRef.current[key]) {
            clearTimeout(debounceTimerRef.current[key]);
          }
        });
        debounceTimerRef.current = {};
      }, 50);
    };

    // 🎯 窗口大小变化防抖处理
    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        setShowTooltip({});
        // 清除所有防抖定时器
        Object.keys(debounceTimerRef.current).forEach(key => {
          if (debounceTimerRef.current[key]) {
            clearTimeout(debounceTimerRef.current[key]);
          }
        });
        debounceTimerRef.current = {};
      }, 100);
    };

    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
      // 清理定时器
      if (scrollTimer) clearTimeout(scrollTimer);
      if (resizeTimer) clearTimeout(resizeTimer);
      // 清除所有防抖定时器
      Object.values(debounceTimerRef.current).forEach(timer => {
        if (timer) clearTimeout(timer);
      });
    };
  }, []);

  // 🎯 当下拉菜单关闭时，清除所有tooltip和防抖定时器
  useEffect(() => {
    if (!isOpen) {
      setShowTooltip({});
      // 清除所有防抖定时器
      Object.values(debounceTimerRef.current).forEach(timer => {
        if (timer) clearTimeout(timer);
      });
      debounceTimerRef.current = {};
    }
  }, [isOpen]);

  // 根据类别分组模型
  const groupedModels = useMemo(() => {
    const groups = modelOptions.reduce((groups, model) => {
      if (!groups[model.category]) {
        groups[model.category] = [];
      }
      groups[model.category].push(model);
      return groups;
    }, {} as Record<string, ModelOption[]>);

    // 每组内按显示名称字母排序
    Object.keys(groups).forEach(category => {
      groups[category].sort((a, b) => a.displayName.localeCompare(b.displayName));
    });

    return groups;
  }, [modelOptions]);

  // 🎯 构建模型 ID 到显示名称的映射
  const modelNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    modelOptions.forEach(opt => {
      map[opt.id] = opt.displayName;
    });
    return map;
  }, [modelOptions]);

  // 🆕 构建思考模式备选项列表
  const thinkingOptionsList = useMemo(() => [
    { id: 'auto', label: t('thinking.mode.auto', undefined, 'Auto'), icon: <BrainIcon level="auto" size={16} />, desc: t('thinking.usage.auto', undefined, 'Let model default decide'), mode: 'auto', effort: 'auto' },
    { id: 'off', label: t('thinking.mode.off', undefined, 'Off'), icon: <BrainIcon level="off" size={16} />, desc: t('thinking.usage.off', undefined, 'Force-disable thinking'), mode: 'off', effort: undefined },
    { id: 'low', label: t('thinking.effort.low', undefined, 'Low'), icon: <BrainIcon level="low" size={16} />, desc: t('thinking.usage.effort', undefined, 'Set thinking effort depth'), mode: 'on', effort: 'low' },
    { id: 'medium', label: t('thinking.effort.medium', undefined, 'Medium'), icon: <BrainIcon level="medium" size={16} />, desc: t('thinking.usage.effort', undefined, 'Set thinking effort depth'), mode: 'on', effort: 'medium' },
    { id: 'high', label: t('thinking.effort.high', undefined, 'High'), icon: <BrainIcon level="high" size={16} />, desc: t('thinking.usage.effort', undefined, 'Set thinking effort depth'), mode: 'on', effort: 'high' },
    { id: 'xhigh', label: t('thinking.effort.xhigh', undefined, 'Extended'), icon: <BrainIcon level="max" size={16} />, desc: t('thinking.usage.effort', undefined, 'Set thinking effort depth'), mode: 'on', effort: 'xhigh' },
    { id: 'max', label: t('thinking.effort.max', undefined, 'Max'), icon: <BrainIcon level="max" size={16} />, desc: t('thinking.usage.effort', undefined, 'Set thinking effort depth'), mode: 'on', effort: 'max' }
  ], [t]);

  // 🆕 当前选中的思考配置项
  // 优先级：effort（具体强度）> mode 兜底
  // 原因：在网络层 mode='auto'+effort=具体值 与 mode='on'+effort=具体值
  // 行为完全一致（见 customModel.applyOpenAIChatThinking），所以一旦 effort
  // 是具体值就应当显示对应的强度档位，而不是被 mode='auto' 短路成 auto。
  const currentThinkingOption = useMemo(() => {
    const config = thinkingConfig || { mode: 'auto', effort: 'auto' };
    if (config.mode === 'off') {
      return thinkingOptionsList.find(opt => opt.id === 'off') || thinkingOptionsList[1];
    }
    // effort 是具体强度（非 'auto'/undefined）→ 直接匹配该强度档位
    if (config.effort && config.effort !== 'auto') {
      const matched = thinkingOptionsList.find(opt => opt.mode === 'on' && opt.effort === config.effort);
      if (matched) return matched;
    }
    // effort 为 auto/undefined → 按 mode 兜底
    if (config.mode === 'auto') {
      return thinkingOptionsList.find(opt => opt.id === 'auto') || thinkingOptionsList[0];
    }
    // mode === 'on' 但没指定 effort → 默认 high
    return thinkingOptionsList.find(opt => opt.id === 'high') || thinkingOptionsList[4];
  }, [thinkingConfig, thinkingOptionsList]);

  // 🎚️ 滑块索引：将当前选中的选项映射到 slider 位置
  const sliderIndex = useMemo(() => {
    const idx = thinkingOptionsList.findIndex(opt => opt.id === currentThinkingOption.id);
    return idx >= 0 ? idx : 0;
  }, [currentThinkingOption, thinkingOptionsList]);

  // 🎚️ 滑块变化处理
  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const idx = parseInt(e.target.value, 10);
    const opt = thinkingOptionsList[idx];
    if (opt) {
      updateThinkingConfig({ mode: opt.mode, effort: opt.effort });
    }
  }, [thinkingOptionsList, updateThinkingConfig]);

  return (
    <div
      ref={containerRef}
      className={`model-selector-wrapper ${className}`}
    >
      <div
        className={`model-selector ${disabled || isSwitching ? 'disabled' : ''} ${isOpen ? 'open' : ''}`}
      >
        {/* 触发按钮 */}
        <button
          className="model-selector-trigger"
          onClick={() => !disabled && !loading && !isSwitching && setIsOpen(!isOpen)}
          disabled={disabled || loading || isSwitching}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
        >
          <div className="selected-model">
            {loading ? (
              <>
                <div className="model-icon">⏳</div>
                <div className="model-info">
                  <span className="model-name">{t('model.selector.loading', undefined, 'Loading...')}</span>
                </div>
              </>
            ) : isSwitching ? (
              <>
                <div className="model-icon">
                  <Loader2 size={16} className="spinning" />
                </div>
                <div className="model-info">
                  <span className="model-name">{t('model.selector.switching', undefined, 'Switching...')}</span>
                </div>
              </>
            ) : error ? (
              <>
                <div className="model-icon">⚠️</div>
                <div className="model-info">
                  <span className="model-name">{t('model.selector.error', undefined, 'Error')}</span>
                </div>
              </>
            ) : selectedModel ? (
              <>
                <div className="model-icon">
                  {getCategoryInfo(selectedModel.category).icon}
                </div>
                <div className="model-info">
                  <div
                    className="model-name-wrapper"
                    onMouseEnter={() => handleMouseEnter(`selected-${selectedModel.id}`)}
                    onMouseLeave={() => handleMouseLeave(`selected-${selectedModel.id}`)}
                  >
                    <span
                      className="model-name"
                      ref={el => modelNameRefs.current[`selected-${selectedModel.id}`] = el}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                    >
                      {thinkingConfig?.mode !== 'off' && (
                        <BrainIcon level={currentThinkingOption.id} size={15} />
                      )}
                      {selectedModel.displayName}
                    </span>
                    {showTooltip[`selected-${selectedModel.id}`] && tooltipPosition[`selected-${selectedModel.id}`] && (
                      <div
                        className="model-name-tooltip"
                        style={{
                          top: `${tooltipPosition[`selected-${selectedModel.id}`].top}px`,
                          left: `${tooltipPosition[`selected-${selectedModel.id}`].left}px`,
                          transform: 'translateX(-50%)'
                        }}
                      >
                        {selectedModel.displayName}
                      </div>
                    )}
                  </div>
                  {selectedModel.category !== 'auto' && selectedModel.creditsPerRequest !== undefined && (
                    <span className="model-credits">
                      {selectedModel.creditsPerRequest}x
                    </span>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="model-icon">{getProviderIcon('default', 16)}</div>
                <div className="model-info">
                  <span className="model-name">{t('model.selector.noModel', undefined, 'No Model')}</span>
                </div>
              </>
            )}
          </div>
          <ChevronDown
            size={16}
            className={`chevron ${isOpen ? 'rotated' : ''}`}
          />
        </button>

        {/* 下拉菜单 */}
        {isOpen && (
          <div ref={dropdownRef} className="model-dropdown">
            <div className="dropdown-header">
              <span className="dropdown-title">{t('model.selector.selectModel')}</span>
            </div>

            {/* 🎚️ 思考级别 - 滑块档位选择 */}
            <div className="dropdown-thinking-section">
              <div className="thinking-section-header">
                <span className="thinking-section-title">🧠 {t('command.thinking.description', undefined, 'Thinking Level')}</span>
                <span className="thinking-current-badge">
                  <BrainIcon level={currentThinkingOption.id === 'xhigh' ? 'max' : currentThinkingOption.id as any} size={14} />
                  {currentThinkingOption.label}
                </span>
              </div>
              <div className="thinking-slider-container">
                <input
                  type="range"
                  className="thinking-slider"
                  min="0"
                  max={thinkingOptionsList.length - 1}
                  step="1"
                  value={sliderIndex}
                  onChange={handleSliderChange}
                  style={{
                    '--slider-fill-pct': `${(sliderIndex / (thinkingOptionsList.length - 1)) * 100}%`
                  } as React.CSSProperties}
                />
                <div className="thinking-slider-labels">
                  {thinkingOptionsList.map((opt, idx) => (
                    <span
                      key={opt.id}
                      className={`thinking-slider-label ${idx === sliderIndex ? 'active' : ''}`}
                      onClick={() => {
                        updateThinkingConfig({ mode: opt.mode, effort: opt.effort });
                      }}
                    >
                      {opt.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="model-list">
              {Object.entries(groupedModels)
                .sort(([categoryA], [categoryB]) => categoryA.localeCompare(categoryB))
                .map(([category, models]) => (
                <div key={category} className="model-group">
                  {models.map((model) => {
                    // 🟢 自定义模型：附带 [Provider] 徽章 + 删除按钮。
                    const isCustom = model.category === 'custom';
                    const customProvider = isCustom ? customProviderMap[model.id] : undefined;
                    const badge = isCustom ? getCustomBadge(customProvider) : null;
                    return (
                    <div
                      key={model.id}
                      className={`model-option ${selectedModel?.id === model.id ? 'selected' : ''} ${!model.isAvailable ? 'disabled' : ''}`}
                      onClick={() => handleModelSelect(model)}
                      role="option"
                      aria-selected={selectedModel?.id === model.id}
                    >
                      <div className="model-option-content">
                        <div className="model-icon">
                          {getCategoryInfo(model.category).icon}
                        </div>
                        <div className="model-details">
                          <div className="model-main">
                            <div
                              className="model-name-wrapper"
                              onMouseEnter={() => handleMouseEnter(`option-${model.id}`)}
                              onMouseLeave={() => handleMouseLeave(`option-${model.id}`)}
                            >
                              <span
                                className="model-name"
                                ref={el => modelNameRefs.current[`option-${model.id}`] = el}
                              >
                                {/* 🟢 [Provider] 前缀 — 只对自定义模型显示，
                                     用主题色让用户一眼区分协议族。 */}
                                {badge && (
                                  <span
                                    className="model-custom-badge"
                                    style={{ color: badge.cssVar }}
                                  >
                                    [{badge.label}]
                                  </span>
                                )}
                                {model.displayName}
                              </span>
                              {showTooltip[`option-${model.id}`] && tooltipPosition[`option-${model.id}`] && (
                                <div
                                  className="model-name-tooltip"
                                  style={{
                                    top: `${tooltipPosition[`option-${model.id}`].top}px`,
                                    left: `${tooltipPosition[`option-${model.id}`].left}px`,
                                    transform: 'translateX(-50%)'
                                  }}
                                >
                                  {badge ? `[${badge.label}] ` : ''}{model.displayName}
                                </div>
                              )}
                            </div>
                            {model.category !== 'auto' && model.creditsPerRequest !== undefined && (
                              <span className="model-credits">
                                {model.creditsPerRequest}x
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      {/* 🟢 自定义模型展示 X 删除；其他模型保持原有 ✓ 选中标记。
                           即使是被选中的自定义模型，外层 .selected 类的样式
                           已经能区分选中态，所以这里优先展示 X，便于点删。 */}
                      {model.category === 'custom' ? (
                        <button
                          type="button"
                          className="model-delete-btn"
                          aria-label={`Delete custom model ${model.displayName}`}
                          title="Delete this custom model"
                          onClick={(e) => handleDeleteCustomModel(e, model.id, model.displayName)}
                        >
                          <X size={14} />
                        </button>
                      ) : (
                        selectedModel?.id === model.id && (
                          <div className="check-icon">
                            <Check size={16} />
                          </div>
                        )
                      )}
                    </div>
                    );
                  })}
                </div>
              ))}
              {/* 🟢 + Add Custom Model — 始终位于列表末尾，
                  即便用户尚未登录、ModelSelector 已经能渲染（云模型走 fallback）
                  也能通过这里打开向导。 */}
              <div
                className="model-option model-option-add-custom"
                onClick={() => {
                  setIsOpen(false);
                  setIsWizardOpen(true);
                }}
                role="button"
                aria-label="Add custom model"
                style={{ cursor: 'pointer' }}
              >
                <div className="model-option-content">
                  <div className="model-icon">
                    <Plus size={16} />
                  </div>
                  <div className="model-details">
                    <div className="model-main">
                      <span className="model-name">
                        {t('model.selector.addCustom', undefined, '+ Add Custom Model')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 🎯 新增：统计按钮 */}
      {!loading && !error && (
        <button
          className="model-stats-trigger"
          onClick={(e) => {
            e.stopPropagation();
            setIsStatsOpen(true);
          }}
          title={t('stats.title')}
        >
          <BarChart2 size={14} />
        </button>
      )}

      {/* 🎯 新增：统计对话框 */}
      <SessionStatisticsDialog
        isOpen={isStatsOpen}
        onClose={() => setIsStatsOpen(false)}
        messages={messages}
        modelNameMap={modelNameMap}
      />

      {/* 🟢 自定义模型向导 — 直接 mount，不依赖登录态。 */}
      <CustomModelWizard
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onSaved={() => {
          // 保存成功后立刻刷新一次列表，避免要等下一轮 broadcast。
          setModelListRefreshTick((prev) => prev + 1);
        }}
      />
    </div>
  );
};
