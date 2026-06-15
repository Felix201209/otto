/**
 * NanoBanana Image Generation Dialog - Multi-turn Conversation Mode
 * 图像生成对话框 - 支持多轮会话的生图界面
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X, Upload, ExternalLink, Image as ImageIcon, Sparkles, RefreshCw, MessageCircle, User, Ratio, Maximize2 } from 'lucide-react';

// 图片生成动画图标 - 彩色风车/花朵
const GeneratingImageIcon: React.FC<{ size?: number }> = ({ size = 120 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    xmlns="http://www.w3.org/2000/svg"
    style={{ display: 'block' }}
  >
    <path fill="#FFB74D" d="M24.449,22.978c-0.157-0.18-0.317-0.357-0.449-0.55c-0.132,0.193-0.292,0.371-0.449,0.55C23.7,22.988,23.848,23,24,23S24.3,22.988,24.449,22.978z"/>
    <path fill="#FFB74D" d="M23.293,14.808c0.27,0.27,0.5,0.563,0.707,0.866c0.208-0.303,0.438-0.596,0.707-0.866l4.949-4.95c0.102-0.101,0.218-0.172,0.322-0.264C29.77,6.471,27.177,4,24,4s-5.77,2.471-5.979,5.594c0.105,0.092,0.222,0.163,0.323,0.264L23.293,14.808z"/>
    <path fill="#64B5F6" d="M23.551,25.021c0.157,0.181,0.317,0.357,0.449,0.551c0.132-0.192,0.292-0.37,0.449-0.551C24.3,25.012,24.152,25,24,25S23.7,25.012,23.551,25.021z"/>
    <path fill="#64B5F6" d="M24.707,33.191c-0.27-0.27-0.5-0.562-0.707-0.865c-0.208,0.305-0.438,0.597-0.707,0.865l-4.95,4.951c-0.101,0.1-0.217,0.172-0.323,0.264C18.23,41.529,20.823,44,24,44s5.77-2.471,5.979-5.594c-0.104-0.092-0.222-0.164-0.322-0.264L24.707,33.191z"/>
    <path fill="#F48FB1" d="M14.808,24.707c0.27-0.27,0.562-0.5,0.866-0.707c-0.303-0.208-0.596-0.438-0.866-0.707l-4.95-4.95c-0.101-0.101-0.172-0.217-0.264-0.323C6.471,18.23,4,20.823,4,24s2.471,5.77,5.594,5.979c0.092-0.104,0.163-0.222,0.264-0.322L14.808,24.707z"/>
    <path fill="#F48FB1" d="M22.978,23.551c-0.18,0.157-0.357,0.317-0.55,0.449c0.193,0.132,0.371,0.292,0.55,0.449C22.988,24.3,23,24.152,23,24S22.988,23.7,22.978,23.551z"/>
    <path fill="#8BC34A" d="M25,24c0,0.152,0.012,0.3,0.021,0.449c0.181-0.157,0.357-0.317,0.551-0.449c-0.192-0.132-0.37-0.292-0.551-0.449C25.012,23.7,25,23.848,25,24z"/>
    <path fill="#8BC34A" d="M44,24c0-3.177-2.471-5.77-5.594-5.979c-0.092,0.105-0.164,0.222-0.264,0.323l-4.951,4.95c-0.27,0.27-0.563,0.5-0.865,0.707c0.305,0.208,0.597,0.438,0.865,0.707l4.951,4.949c0.1,0.102,0.172,0.218,0.264,0.323C41.529,29.77,44,27.177,44,24z"/>
    <path fill="#C0CA33" d="M30,17c0,0.378-0.039,0.747-0.105,1.106C30.253,18.039,30.621,18,31,18h7c0.137,0,0.271,0.012,0.406,0.021c2.05-2.357,1.979-5.92-0.264-8.163c-2.244-2.242-5.807-2.314-8.164-0.264C29.988,9.729,30,9.863,30,10V17z"/>
    <path fill="#C0CA33" d="M25.021,23.551c0.018-0.223,0.045-0.442,0.084-0.657c-0.215,0.041-0.435,0.067-0.656,0.084c0.09,0.103,0.16,0.217,0.258,0.315S24.919,23.461,25.021,23.551z"/>
    <path fill="#F9A825" d="M24.707,14.808c-0.27,0.27-0.5,0.563-0.707,0.866c1.389,2.033,1.389,4.722,0,6.754c0.132,0.193,0.292,0.371,0.449,0.55c0.223-0.017,0.441-0.043,0.656-0.084c0.453-2.425,2.362-4.335,4.787-4.787C29.961,17.747,30,17.378,30,17v-7c0-0.137-0.012-0.271-0.021-0.406c-0.104,0.092-0.222,0.163-0.322,0.264L24.707,14.808z"/>
    <path fill="#689F38" d="M31,18c-0.379,0-0.747,0.039-1.105,0.106c-0.453,2.425-2.362,4.335-4.787,4.787c-0.041,0.215-0.067,0.435-0.084,0.657c0.18,0.157,0.356,0.317,0.55,0.449c2.032-1.389,4.723-1.389,6.754,0c0.304-0.208,0.597-0.438,0.866-0.707l4.949-4.95c0.101-0.101,0.172-0.217,0.265-0.323C38.271,18.012,38.137,18,38,18H31z"/>
    <path fill="#827717" d="M29.895,18.106c-2.426,0.452-4.336,2.362-4.787,4.787C27.531,22.441,29.441,20.532,29.895,18.106z"/>
    <path fill="#BA68C8" d="M18,31c0-0.379,0.039-0.747,0.106-1.105C17.747,29.961,17.378,30,17,30h-7c-0.137,0-0.271-0.012-0.406-0.021c-2.05,2.357-1.979,5.922,0.264,8.164c2.242,2.241,5.805,2.313,8.163,0.264C18.012,38.271,18,38.137,18,38V31z"/>
    <path fill="#BA68C8" d="M22.978,24.449c-0.017,0.223-0.043,0.441-0.084,0.656c0.215-0.039,0.435-0.066,0.657-0.084c-0.09-0.103-0.16-0.217-0.258-0.314S23.081,24.539,22.978,24.449z"/>
    <path fill="#5C6BC0" d="M23.293,33.191c0.27-0.27,0.5-0.562,0.707-0.865c-1.389-2.031-1.389-4.721,0-6.754c-0.132-0.192-0.292-0.37-0.449-0.551c-0.223,0.018-0.442,0.045-0.657,0.084c-0.452,2.426-2.362,4.336-4.787,4.787C18.039,30.253,18,30.621,18,31v7c0,0.137,0.012,0.271,0.021,0.406c0.105-0.092,0.222-0.164,0.323-0.264L23.293,33.191z"/>
    <path fill="#D81B60" d="M17,30c0.378,0,0.747-0.039,1.106-0.105c0.452-2.426,2.362-4.336,4.787-4.787c0.041-0.215,0.067-0.436,0.084-0.657c-0.18-0.157-0.357-0.317-0.55-0.449c-2.032,1.39-4.721,1.39-6.754,0c-0.304,0.208-0.596,0.438-0.866,0.707l-4.95,4.949c-0.101,0.102-0.172,0.218-0.264,0.323C9.729,29.988,9.863,30,10,30H17z"/>
    <path fill="#880E4F" d="M18.106,29.895c2.425-0.453,4.335-2.362,4.787-4.787C20.468,25.559,18.559,27.469,18.106,29.895z"/>
    <path fill="#FF5252" d="M23.551,22.978c-0.223-0.017-0.442-0.043-0.657-0.084c0.041,0.215,0.067,0.435,0.084,0.657c0.103-0.09,0.217-0.16,0.315-0.258S23.461,23.081,23.551,22.978z"/>
    <path fill="#FF5252" d="M17,18c0.378,0,0.747,0.039,1.106,0.106C18.039,17.747,18,17.378,18,17v-7c0-0.137,0.012-0.271,0.021-0.406c-2.357-2.05-5.92-1.979-8.163,0.264c-2.243,2.243-2.314,5.805-0.264,8.163C9.729,18.012,9.863,18,10,18H17z"/>
    <path fill="#EF6C00" d="M18,17c0,0.378,0.039,0.747,0.106,1.106c2.425,0.452,4.335,2.362,4.787,4.787c0.215,0.041,0.435,0.067,0.657,0.084c0.157-0.18,0.317-0.357,0.449-0.55c-1.389-2.032-1.389-4.721,0-6.754c-0.208-0.303-0.438-0.596-0.707-0.866l-4.95-4.95c-0.101-0.101-0.217-0.172-0.323-0.264C18.012,9.729,18,9.863,18,10V17z"/>
    <path fill="#F44336" d="M14.808,23.293c0.27,0.27,0.563,0.5,0.866,0.707c2.032-1.389,4.721-1.389,6.754,0c0.193-0.132,0.371-0.292,0.55-0.449c-0.017-0.223-0.043-0.442-0.084-0.657c-2.425-0.452-4.335-2.362-4.787-4.787C17.747,18.039,17.378,18,17,18h-7c-0.137,0-0.271,0.012-0.406,0.021c0.092,0.105,0.163,0.222,0.264,0.323L14.808,23.293z"/>
    <path fill="#DD2C00" d="M18.106,18.106c0.452,2.425,2.362,4.335,4.787,4.787C22.441,20.468,20.532,18.559,18.106,18.106z"/>
    <path fill="#E65100" d="M24,15.673c-1.389,2.033-1.389,4.722,0,6.754C25.389,20.395,25.389,17.706,24,15.673z"/>
    <path fill="#B71C1C" d="M15.673,24c2.033,1.389,4.722,1.389,6.754,0C20.395,22.611,17.706,22.611,15.673,24z"/>
    <path fill="#00ACC1" d="M31,30c-0.379,0-0.747-0.039-1.105-0.105C29.961,30.253,30,30.621,30,31v7c0,0.137-0.012,0.271-0.021,0.406c2.357,2.05,5.922,1.979,8.164-0.264c2.241-2.244,2.313-5.807,0.264-8.164C38.271,29.988,38.137,30,38,30H31z"/>
    <path fill="#00ACC1" d="M24.449,25.021c0.223,0.018,0.441,0.045,0.656,0.084c-0.039-0.215-0.066-0.435-0.084-0.656c-0.103,0.09-0.217,0.16-0.314,0.258S24.539,24.919,24.449,25.021z"/>
    <path fill="#0277BD" d="M30,31c0-0.379-0.039-0.747-0.105-1.105c-2.426-0.453-4.336-2.362-4.787-4.787c-0.215-0.041-0.436-0.067-0.657-0.084c-0.157,0.18-0.317,0.356-0.449,0.55c1.39,2.032,1.39,4.723,0,6.754c0.208,0.305,0.438,0.597,0.707,0.866l4.949,4.949c0.102,0.101,0.218,0.172,0.323,0.265C29.988,38.271,30,38.137,30,38V31z"/>
    <path fill="#00796B" d="M33.191,24.707c-0.27-0.27-0.562-0.5-0.865-0.707c-2.032,1.389-4.721,1.389-6.754,0c-0.192,0.132-0.37,0.292-0.551,0.449c0.018,0.223,0.045,0.441,0.084,0.656c2.426,0.453,4.336,2.362,4.787,4.787C30.253,29.961,30.621,30,31,30h7c0.137,0,0.271-0.012,0.406-0.021c-0.092-0.104-0.164-0.222-0.264-0.322L33.191,24.707z"/>
    <path fill="#006064" d="M29.895,29.895c-0.453-2.426-2.362-4.336-4.787-4.787C25.559,27.531,27.469,29.441,29.895,29.895z"/>
    <path fill="#1B5E20" d="M25.572,24c2.033,1.389,4.722,1.389,6.754,0C30.295,22.611,27.605,22.611,25.572,24z"/>
    <path fill="#0D47A1" d="M24,32.326c1.389-2.031,1.389-4.721,0-6.754C22.611,27.605,22.611,30.295,24,32.326z"/>
  </svg>
);
import { useTranslation } from '../hooks/useTranslation';
import { NanoBananaIcon } from './NanoBananaIcon';
import { getGlobalMessageService } from '../services/globalMessageService';
import './NanoBananaDialog.css';

// 🎯 宽高比选项
const ASPECT_RATIOS = [
  { value: 'auto', label: 'Auto' },
  { value: '1:1', label: '1:1' },
  { value: '2:3', label: '2:3' },
  { value: '3:2', label: '3:2' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '4:5', label: '4:5' },
  { value: '5:4', label: '5:4' },
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
  { value: '21:9', label: '21:9' },
];

// 🎯 图片尺寸选项
const IMAGE_SIZES = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
];

// 🎯 生成状态
type GenerationStatus = 'idle' | 'uploading' | 'generating' | 'polling' | 'completed' | 'error';

// 🎯 单张参考图信息
interface ReferenceImage {
  url: string | null;       // 原始 URL（上传后获得），传递给后端
  preview: string;           // base64/dataURL 预览图，用于 UI 显示
  source: 'generated' | 'uploaded';
}

// 🎯 单条对话消息
interface NanoBananaMessage {
  id: string;
  role: 'user' | 'assistant';
  timestamp: number;
  // 用户消息
  prompt?: string;
  uploadedImageUrls?: string[];  // 用户上传/选择的参考图预览（可多张）
  // AI响应
  generatedImageUrls?: string[];  // base64 for display
  originalImageUrls?: string[];   // original URLs for browser
  creditsDeducted?: number;
  errorMessage?: string;
  // 生成参数
  aspectRatio?: string;
  imageSize?: string;
  referenceImageUrls?: string[];  // 生成时实际传给后端的参考图 URL 列表
}

const MAX_REFERENCE_IMAGES = 5;

// 🎯 对话状态
interface ConversationState {
  messages: NanoBananaMessage[];
  currentStatus: GenerationStatus;
  currentTaskId: string | null;
  // 多张参考图
  currentReferences: ReferenceImage[];
  progress: number;
  estimatedTime: number;
  elapsedTime: number;
}

interface NanoBananaDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const NanoBananaDialog: React.FC<NanoBananaDialogProps> = ({
  isOpen,
  onClose,
}) => {
  const { t } = useTranslation();

  // 对话状态
  const [conversation, setConversation] = useState<ConversationState>({
    messages: [],
    currentStatus: 'idle',
    currentTaskId: null,
    currentReferences: [],
    progress: 0,
    estimatedTime: 60,
    elapsedTime: 0,
  });

  // 输入状态
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState('auto');
  const [imageSize, setImageSize] = useState('1K');

  // 待上传的参考图文件列表（仅用于上传流程）
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[]>([]);

  // 图片加载失败跟踪
  const [failedImageIndices, setFailedImageIndices] = useState<Set<string>>(new Set());

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const conversationEndRef = useRef<HTMLDivElement>(null);
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const currentTaskIdRef = useRef<string | null>(null);

  // 🎯 清理所有定时器
  const clearAllIntervals = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  // 🎯 滚动到对话底部
  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }, []);

  // 🎯 组件卸载时清理
  useEffect(() => {
    return () => {
      clearAllIntervals();
    };
  }, [clearAllIntervals]);

  // 🎯 监听状态更新
  useEffect(() => {
    const messageService = getGlobalMessageService();

    const handleStatusUpdate = (data: {
      taskId: string;
      status: 'pending' | 'processing' | 'completed' | 'failed';
      progress?: number;
      resultUrls?: string[];
      originalUrls?: string[];
      errorMessage?: string;
      creditsDeducted?: number;
    }) => {
      if (!currentTaskIdRef.current || data.taskId !== currentTaskIdRef.current) {
        return;
      }

      console.log('📊 [NanoBanana] Status update received:', data);

      if (data.status === 'completed' && data.resultUrls) {
        clearAllIntervals();
        currentTaskIdRef.current = null;

        // 添加 AI 响应消息
        const assistantMessage: NanoBananaMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          timestamp: Date.now(),
          generatedImageUrls: data.resultUrls,
          originalImageUrls: data.originalUrls || data.resultUrls,
          creditsDeducted: data.creditsDeducted,
        };

        setConversation(prev => {
          // 生成完成后，自动将第一张结果图设为当前参考图
          const newReferences: ReferenceImage[] = [];
          if (data.resultUrls?.[0]) {
            newReferences.push({
              url: data.originalUrls?.[0] || data.resultUrls[0],
              preview: data.resultUrls[0],
              source: 'generated',
            });
          }
          return {
            ...prev,
            messages: [...prev.messages, assistantMessage],
            currentStatus: 'idle',
            currentTaskId: null,
            currentReferences: newReferences,
            progress: 100,
          };
        });
        // 清除待上传文件
        setPendingUploadFiles([]);

        scrollToBottom();
      } else if (data.status === 'failed') {
        clearAllIntervals();
        currentTaskIdRef.current = null;

        // 添加错误消息
        const errorMessage: NanoBananaMessage = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          timestamp: Date.now(),
          errorMessage: data.errorMessage || 'Generation failed',
        };

        setConversation(prev => ({
          ...prev,
          messages: [...prev.messages, errorMessage],
          currentStatus: 'error',
          currentTaskId: null,
        }));

        scrollToBottom();
      }
    };

    const unsubscribe = messageService.onNanoBananaStatusUpdate(handleStatusUpdate);
    return () => unsubscribe();
  }, [clearAllIntervals, scrollToBottom]);

  // 处理ESC键关闭
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && conversation.currentStatus === 'idle') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, conversation.currentStatus]);

  // 自动聚焦输入框
  useEffect(() => {
    if (isOpen && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // 🎯 处理图片文件（用户上传新参考图）
  const processImageFile = useCallback((file: File): boolean => {
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'];
    if (!validTypes.includes(file.type)) {
      return false;
    }

    if (file.size > 10 * 1024 * 1024) {
      return false;
    }

    // 检查总参考图数量
    setConversation(prev => {
      if (prev.currentReferences.length >= MAX_REFERENCE_IMAGES) {
        return prev;
      }
      // 立即显示预览
      const reader = new FileReader();
      reader.onload = (event) => {
        const preview = event.target?.result as string;
        setConversation(p => ({
          ...p,
          currentReferences: [...p.currentReferences, {
            url: null,
            preview,
            source: 'uploaded',
          }],
        }));
      };
      reader.readAsDataURL(file);
      return prev;
    });

    // 添加到待上传文件列表
    setPendingUploadFiles(prev => {
      if (prev.length + conversation.currentReferences.length >= MAX_REFERENCE_IMAGES) {
        return prev;
      }
      return [...prev, file];
    });
    return true;
  }, [conversation.currentReferences.length]);

  // 处理参考图片上传（支持多选）
  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      processImageFile(files[i]);
    }
  }, [processImageFile]);

  // 🎯 处理粘贴图片（任何轮次都支持）
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          processImageFile(file);
        }
        break;
      }
    }
  }, [processImageFile]);

  // 🎯 注册粘贴事件监听
  useEffect(() => {
    if (!isOpen || conversation.currentStatus !== 'idle') return;

    const handler = (e: Event) => handlePaste(e as ClipboardEvent);
    document.addEventListener('paste', handler);
    return () => document.removeEventListener('paste', handler);
  }, [isOpen, conversation.currentStatus, handlePaste]);

  // 🎯 清除所有参考图
  const clearAllReferences = useCallback(() => {
    setPendingUploadFiles([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setConversation(prev => ({
      ...prev,
      currentReferences: [],
    }));
  }, []);

  // 🎯 清除指定索引的参考图
  const removeReference = useCallback((index: number) => {
    setConversation(prev => ({
      ...prev,
      currentReferences: prev.currentReferences.filter((_, i) => i !== index),
    }));
    // 同步清理待上传文件列表中对应的 uploaded 项
    setPendingUploadFiles(prev => {
      // 需要找到对应的 pending file 索引
      // uploaded 类型的 reference 与 pendingUploadFiles 对应
      let uploadedIdx = 0;
      const refs = conversation.currentReferences;
      for (let i = 0; i < index; i++) {
        if (refs[i]?.source === 'uploaded' && refs[i]?.url === null) {
          uploadedIdx++;
        }
      }
      if (refs[index]?.source === 'uploaded' && refs[index]?.url === null) {
        return prev.filter((_, i) => i !== uploadedIdx);
      }
      return prev;
    });
  }, [conversation.currentReferences]);

  // 🎯 开始图像生成
  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) return;

    const isGenerating = conversation.currentStatus !== 'idle' && conversation.currentStatus !== 'error';
    if (isGenerating) return;

    clearAllIntervals();

    // 记录当前使用的参考图预览（供对话历史显示）
    const referencePreviews = conversation.currentReferences.map(r => r.preview);

    // 添加用户消息到对话历史
    const userMessage: NanoBananaMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      timestamp: Date.now(),
      prompt: prompt.trim(),
      aspectRatio,
      imageSize,
      uploadedImageUrls: referencePreviews.length > 0 ? referencePreviews : undefined,
    };

    setConversation(prev => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      currentStatus: pendingUploadFiles.length > 0 ? 'uploading' : 'generating',
      progress: 0,
      estimatedTime: 60,
      elapsedTime: 0,
    }));

    scrollToBottom();

    try {
      const messageService = getGlobalMessageService();

      // 收集所有参考图的最终 URL
      const finalReferenceUrls: string[] = [];

      // 已有 URL 的参考图（来自上一轮生成或之前已上传）
      for (const ref of conversation.currentReferences) {
        if (ref.url) {
          finalReferenceUrls.push(ref.url);
        }
      }

      // 如果有待上传的文件，先上传
      if (pendingUploadFiles.length > 0) {
        if (pendingUploadFiles.length === 1) {
          // 单文件：用原有单文件上传接口
          const file = pendingUploadFiles[0];
          const reader = new FileReader();
          const fileData = await new Promise<string>((resolve, reject) => {
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });

          messageService.sendNanoBananaUpload({
            filename: file.name,
            contentType: file.type,
            fileData: fileData,
          });

          const uploadedUrl = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Upload timeout')), 30000);
            const unsubUpload = messageService.onNanoBananaUploadResponse((data) => {
              clearTimeout(timeout);
              unsubUpload();
              if (data.success && data.publicUrl) {
                resolve(data.publicUrl);
              } else {
                reject(new Error(data.error || 'Upload failed'));
              }
            });
          });

          finalReferenceUrls.push(uploadedUrl);
        } else {
          // 多文件：用批量上传接口
          const filesData = await Promise.all(
            pendingUploadFiles.map(file => {
              return new Promise<{ filename: string; contentType: string; fileData: string }>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve({
                  filename: file.name,
                  contentType: file.type,
                  fileData: reader.result as string,
                });
                reader.onerror = reject;
                reader.readAsDataURL(file);
              });
            })
          );

          messageService.sendNanoBananaBatchUpload({ files: filesData });

          const uploadedUrls = await new Promise<string[]>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Batch upload timeout')), 60000);
            const unsubBatch = messageService.onNanoBananaBatchUploadResponse((data) => {
              clearTimeout(timeout);
              unsubBatch();
              if (data.success && data.publicUrls) {
                resolve(data.publicUrls);
              } else {
                reject(new Error(data.error || 'Batch upload failed'));
              }
            });
          });

          finalReferenceUrls.push(...uploadedUrls);
        }

        setPendingUploadFiles([]);
      }

      setConversation(prev => ({ ...prev, currentStatus: 'generating' }));

      // 构建请求参数
      const generateRequest: any = {
        prompt: prompt.trim(),
        aspectRatio,
        imageSize,
      };

      // 传递参考图 URL
      if (finalReferenceUrls.length === 1) {
        // 单图：保持向后兼容，用 referenceImageUrl
        generateRequest.referenceImageUrl = finalReferenceUrls[0];
      } else if (finalReferenceUrls.length > 1) {
        // 多图：用 referenceImageUrls 数组
        generateRequest.referenceImageUrls = finalReferenceUrls;
      }

      // 多轮会话上下文
      if (finalReferenceUrls.length > 0 && conversation.messages.length > 0) {
        generateRequest.conversationContext = {
          previousGeneratedImageUrl: finalReferenceUrls[0],
          history: conversation.messages.map(m => ({
            role: m.role,
            prompt: m.prompt,
            imageUrl: m.role === 'assistant' ? m.originalImageUrls?.[0] : undefined,
          })),
        };
      }

      // 将实际使用的参考图 URL 回写到 user 消息中
      if (finalReferenceUrls.length > 0) {
        setConversation(prev => {
          const msgs = [...prev.messages];
          const lastUserIdx = msgs.length - 1;
          if (msgs[lastUserIdx] && msgs[lastUserIdx].role === 'user') {
            msgs[lastUserIdx] = { ...msgs[lastUserIdx], referenceImageUrls: finalReferenceUrls };
          }
          return { ...prev, messages: msgs };
        });
      }

      // 发送生成请求
      messageService.sendNanoBananaGenerate(generateRequest);

      // 等待生成任务创建响应
      const taskResponse = await new Promise<{ taskId: string; estimatedTime: number }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Generation request timeout')), 30000);
        const unsubGenerate = messageService.onNanoBananaGenerateResponse((data) => {
          clearTimeout(timeout);
          unsubGenerate();
          if (data.success && data.taskId) {
            resolve({ taskId: data.taskId, estimatedTime: data.estimatedTime || 60 });
          } else {
            reject(new Error(data.error || 'Failed to start generation'));
          }
        });
      });

      currentTaskIdRef.current = taskResponse.taskId;

      setConversation(prev => ({
        ...prev,
        currentStatus: 'polling',
        currentTaskId: taskResponse.taskId,
        estimatedTime: taskResponse.estimatedTime,
        elapsedTime: 0,
      }));

      // 开始轮询
      pollingIntervalRef.current = setInterval(() => {
        messageService.sendNanoBananaStatus({ taskId: taskResponse.taskId });
      }, 1000);

      // 开始倒计时
      countdownIntervalRef.current = setInterval(() => {
        setConversation(prev => {
          if (prev.currentStatus !== 'polling') return prev;
          const newElapsed = prev.elapsedTime + 1;
          const newEstimated = newElapsed >= prev.estimatedTime ? prev.estimatedTime + 10 : prev.estimatedTime;
          const newProgress = Math.min(99, Math.round((newElapsed / newEstimated) * 100));
          return {
            ...prev,
            elapsedTime: newElapsed,
            estimatedTime: newEstimated,
            progress: newProgress,
          };
        });
      }, 1000);

    } catch (error) {
      clearAllIntervals();
      currentTaskIdRef.current = null;

      const errorMessage: NanoBananaMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        timestamp: Date.now(),
        errorMessage: error instanceof Error ? error.message : 'Unknown error occurred',
      };

      setConversation(prev => ({
        ...prev,
        messages: [...prev.messages, errorMessage],
        currentStatus: 'error',
        currentTaskId: null,
      }));

      scrollToBottom();
    }
  }, [prompt, aspectRatio, imageSize, pendingUploadFiles, conversation, clearAllIntervals, scrollToBottom]);

  // 打开图片
  const openImage = useCallback((url: string) => {
    if (url.startsWith('data:')) {
      const newWindow = window.open();
      if (newWindow) {
        newWindow.document.write(`<img src="${url}" style="max-width:100%;height:auto;" />`);
      }
    } else {
      const messageService = getGlobalMessageService();
      messageService.openExternalUrl(url);
    }
  }, []);

  // 🎯 新对话
  const handleNewConversation = useCallback(() => {
    clearAllIntervals();
    currentTaskIdRef.current = null;
    setConversation({
      messages: [],
      currentStatus: 'idle',
      currentTaskId: null,
      currentReferences: [],
      progress: 0,
      estimatedTime: 60,
      elapsedTime: 0,
    });
    setPrompt('');
    setPendingUploadFiles([]);
    setFailedImageIndices(new Set());
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setTimeout(() => textareaRef.current?.focus(), 100);
  }, [clearAllIntervals]);

  // 🎯 再次生成：用生成当前图片时的原始参考图和提示词重新生成
  const handleRegenerate = useCallback(async (messageIndex: number) => {
    const isGeneratingNow = conversation.currentStatus !== 'idle' && conversation.currentStatus !== 'error';
    if (isGeneratingNow) return;

    // 找到对应的 user 消息（assistant 消息的前一条）
    const userMsg = conversation.messages.slice(0, messageIndex).reverse().find(m => m.role === 'user');
    if (!userMsg || !userMsg.prompt) return;

    clearAllIntervals();

    // 用原始参数重新添加 user 消息
    const userMessage: NanoBananaMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      timestamp: Date.now(),
      prompt: userMsg.prompt,
      aspectRatio: userMsg.aspectRatio || 'auto',
      imageSize: userMsg.imageSize || '1K',
      uploadedImageUrls: userMsg.uploadedImageUrls || undefined,
    };

    setConversation(prev => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      currentStatus: 'generating',
      progress: 0,
      estimatedTime: 60,
      elapsedTime: 0,
    }));

    scrollToBottom();

    try {
      const messageService = getGlobalMessageService();

      // 构建请求参数 - 使用原始 prompt 和参数
      const generateRequest: any = {
        prompt: userMsg.prompt,
        aspectRatio: userMsg.aspectRatio || 'auto',
        imageSize: userMsg.imageSize || '1K',
      };

      // 使用 user 消息中记录的实际参考图 URL
      const refUrls = userMsg.referenceImageUrls;
      if (refUrls && refUrls.length === 1) {
        generateRequest.referenceImageUrl = refUrls[0];
      } else if (refUrls && refUrls.length > 1) {
        generateRequest.referenceImageUrls = refUrls;
      }

      // 将参考图 URL 回写到新 user 消息中
      if (refUrls && refUrls.length > 0) {
        setConversation(prev => {
          const msgs = [...prev.messages];
          const lastIdx = msgs.length - 1;
          if (msgs[lastIdx]?.role === 'user') {
            msgs[lastIdx] = { ...msgs[lastIdx], referenceImageUrls: refUrls };
          }
          return { ...prev, messages: msgs };
        });
      }

      // 发送生成请求
      messageService.sendNanoBananaGenerate(generateRequest);

      // 等待生成任务创建响应
      const taskResponse = await new Promise<{ taskId: string; estimatedTime: number }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Generation request timeout')), 30000);
        const unsubRegenerate = messageService.onNanoBananaGenerateResponse((data) => {
          clearTimeout(timeout);
          unsubRegenerate();
          if (data.success && data.taskId) {
            resolve({ taskId: data.taskId, estimatedTime: data.estimatedTime || 60 });
          } else {
            reject(new Error(data.error || 'Failed to start generation'));
          }
        });
      });

      currentTaskIdRef.current = taskResponse.taskId;

      setConversation(prev => ({
        ...prev,
        currentStatus: 'polling',
        currentTaskId: taskResponse.taskId,
        estimatedTime: taskResponse.estimatedTime,
        elapsedTime: 0,
      }));

      pollingIntervalRef.current = setInterval(() => {
        messageService.sendNanoBananaStatus({ taskId: taskResponse.taskId });
      }, 1000);

      countdownIntervalRef.current = setInterval(() => {
        setConversation(prev => {
          if (prev.currentStatus !== 'polling') return prev;
          const newElapsed = prev.elapsedTime + 1;
          const newEstimated = newElapsed >= prev.estimatedTime ? prev.estimatedTime + 10 : prev.estimatedTime;
          const newProgress = Math.min(99, Math.round((newElapsed / newEstimated) * 100));
          return {
            ...prev,
            elapsedTime: newElapsed,
            estimatedTime: newEstimated,
            progress: newProgress,
          };
        });
      }, 1000);

      scrollToBottom();

    } catch (error: any) {
      console.error('[NanoBanana] Regenerate error:', error);
      clearAllIntervals();
      currentTaskIdRef.current = null;

      const errorMessage: NanoBananaMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        timestamp: Date.now(),
        errorMessage: error.message || 'Regeneration failed',
      };

      setConversation(prev => ({
        ...prev,
        messages: [...prev.messages, errorMessage],
        currentStatus: 'error',
      }));

      scrollToBottom();
    }
  }, [conversation, clearAllIntervals, scrollToBottom]);

  // 🎯 选择图片作为参考（点击历史图片的"选为参考"按钮，添加到参考图列表）
  const handleSelectAsReference = useCallback((originalUrl: string, previewUrl: string) => {
    setConversation(prev => {
      if (prev.currentReferences.length >= MAX_REFERENCE_IMAGES) {
        return prev;
      }
      return {
        ...prev,
        currentReferences: [...prev.currentReferences, {
          url: originalUrl,
          preview: previewUrl,
          source: 'generated',
        }],
      };
    });
  }, []);

  // 处理图片加载失败
  const handleImageLoadError = useCallback((imageId: string) => {
    setFailedImageIndices(prev => {
      const newSet = new Set(prev);
      newSet.add(imageId);
      return newSet;
    });
  }, []);

  // 格式化时间
  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (!isOpen) return null;

  const isGenerating = conversation.currentStatus !== 'idle' && conversation.currentStatus !== 'error';
  const isFirstRound = conversation.messages.length === 0;
  const remainingTime = Math.max(0, conversation.estimatedTime - conversation.elapsedTime);

  return (
    <div className="nanobanana-dialog__backdrop" onClick={isGenerating ? undefined : onClose}>
      <div className="nanobanana-dialog__container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <header className="nanobanana-dialog__header">
          <div className="nanobanana-dialog__title">
            <NanoBananaIcon size={24} />
            <span>{t('nanoBanana.title', {}, 'NanoBanana Image Generator')}</span>
          </div>
          <button
            className="nanobanana-dialog__close-btn"
            onClick={onClose}
            disabled={isGenerating}
            title={t('common.close', {}, 'Close')}
          >
            <X size={18} />
          </button>
        </header>

        {/* Body - 对话历史 */}
        <div className="nanobanana-dialog__body">
          {/* 空状态 */}
          {conversation.messages.length === 0 && !isGenerating && (
            <div className="nanobanana-dialog__empty-state">
              <div className="nanobanana-dialog__empty-icon">
                <NanoBananaIcon size={48} />
              </div>
              <div className="nanobanana-dialog__empty-text">
                {t('nanoBanana.promptPlaceholder', {}, 'Describe the image you want to generate...')}
              </div>
              <div className="nanobanana-dialog__empty-hint">
                {t('nanoBanana.pasteHint', {}, 'You can also paste an image with Ctrl+V')}
              </div>
            </div>
          )}

          {/* 对话历史 */}
          <div className="nanobanana-dialog__conversation">
            {conversation.messages.map((message, messageIndex) => (
              <div
                key={message.id}
                className={`nanobanana-dialog__message nanobanana-dialog__message--${message.role}${message.errorMessage ? ' nanobanana-dialog__message--error' : ''}`}
              >
                {/* 消息头部 */}
                <div className={`nanobanana-dialog__message-header nanobanana-dialog__message-header--${message.role}`}>
                  <span className="nanobanana-dialog__message-icon">
                    {message.role === 'user' ? <User size={14} /> : <NanoBananaIcon size={14} />}
                  </span>
                  <span>
                    {message.role === 'user'
                      ? t('nanoBanana.you', {}, 'You')
                      : t('nanoBanana.assistant', {}, 'NanoBanana')}
                  </span>
                  <span className="nanobanana-dialog__message-time">
                    {formatTime(message.timestamp)}
                  </span>
                </div>

                {/* 用户消息内容 */}
                {message.role === 'user' && (
                  <>
                    <div className="nanobanana-dialog__message-content">
                      {message.prompt}
                    </div>
                    <div className="nanobanana-dialog__message-params">
                      <span className="nanobanana-dialog__message-param">
                        <Ratio size={12} /> {message.aspectRatio}
                      </span>
                      <span className="nanobanana-dialog__message-param">
                        <Maximize2 size={12} /> {message.imageSize}
                      </span>
                    </div>
                    {message.uploadedImageUrls && message.uploadedImageUrls.length > 0 && (
                      <div className="nanobanana-dialog__user-references">
                        {message.uploadedImageUrls.map((imgUrl, idx) => (
                          <div key={idx} className="nanobanana-dialog__user-reference">
                            <img
                              src={imgUrl}
                              alt={`Reference ${idx + 1}`}
                              className="nanobanana-dialog__user-reference-thumb"
                            />
                            <button
                              className="nanobanana-dialog__user-reference-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleSelectAsReference(imgUrl, imgUrl);
                              }}
                              disabled={isGenerating}
                            >
                              {t('nanoBanana.selectAsReference', {}, 'Use as reference')}
                            </button>
                          </div>
                        ))}
                        <span className="nanobanana-dialog__user-reference-text">
                          {t('nanoBanana.referenceImage', {}, 'Reference Image')} ({message.uploadedImageUrls.length})
                        </span>
                      </div>
                    )}
                  </>
                )}

                {/* AI 响应 - 生成的图片 */}
                {message.role === 'assistant' && message.generatedImageUrls && (
                  <>
                    <div className="nanobanana-dialog__message-images">
                      {message.generatedImageUrls.map((url, index) => {
                        const imageId = `${message.id}-${index}`;
                        const originalUrl = message.originalImageUrls?.[index] || url;
                        const hasFailed = failedImageIndices.has(imageId);

                        return (
                          <div key={imageId} className="nanobanana-dialog__message-image-container">
                            <div className="nanobanana-dialog__message-image-wrapper">
                              {hasFailed ? (
                                <div className="nanobanana-dialog__image-failed" onClick={() => openImage(originalUrl)}>
                                  <div className="nanobanana-dialog__image-failed-content">
                                    <p className="nanobanana-dialog__image-failed-text">
                                      {t('nanoBanana.imageTooLarge', {}, 'Image is large, please click to view')}
                                    </p>
                                    <button className="nanobanana-dialog__image-failed-link">
                                      {t('nanoBanana.clickToView', {}, 'Click to View')}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <img
                                  src={url}
                                  alt={`Generated ${index + 1}`}
                                  className="nanobanana-dialog__message-image"
                                  onClick={() => openImage(originalUrl)}
                                  onError={() => handleImageLoadError(imageId)}
                                />
                              )}
                            </div>
                            <div className="nanobanana-dialog__image-actions">
                              <button
                                className="nanobanana-dialog__select-reference-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSelectAsReference(originalUrl, url);
                                }}
                                disabled={isGenerating}
                              >
                                {t('nanoBanana.selectAsReference', {}, 'Use as reference')}
                              </button>
                              <button
                                className="nanobanana-dialog__regenerate-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRegenerate(messageIndex);
                                }}
                                disabled={isGenerating}
                              >
                                {t('nanoBanana.regenerate', {}, 'Regenerate')}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {message.creditsDeducted && (
                      <div className="nanobanana-dialog__message-credits">
                        <Sparkles size={14} />
                        <span>-{message.creditsDeducted} {t('nanoBanana.credits', {}, 'credits')}</span>
                      </div>
                    )}
                  </>
                )}

                {/* AI 响应 - 错误 */}
                {message.role === 'assistant' && message.errorMessage && (
                  <div className="nanobanana-dialog__message-error">
                    <X size={14} />
                    <span>{message.errorMessage}</span>
                  </div>
                )}
              </div>
            ))}

            {/* 生成中状态 */}
            {isGenerating && (
              <div className="nanobanana-dialog__message nanobanana-dialog__message--assistant nanobanana-dialog__message--generating">
                <div className="nanobanana-dialog__message-header nanobanana-dialog__message-header--assistant">
                  <span className="nanobanana-dialog__message-icon"><NanoBananaIcon size={14} /></span>
                  <span>{t('nanoBanana.assistant', {}, 'NanoBanana')}</span>
                </div>
                <div className="nanobanana-dialog__message-generating-content">
                  <div className="nanobanana-dialog__progressive-reveal" style={{
                    filter: conversation.progress <= 50
                      ? `blur(${Math.max(0, 8 - (conversation.progress / 50) * 8)}px)`
                      : 'none',
                    opacity: 0.7 + (conversation.progress / 100) * 0.3,
                    transition: 'filter 0.3s ease-out, opacity 0.3s ease-out',
                  }}>
                    <GeneratingImageIcon size={80} />
                  </div>
                  <div className="nanobanana-dialog__generating-text">
                    {conversation.currentStatus === 'uploading' && t('nanoBanana.uploading', {}, 'Uploading reference image...')}
                    {conversation.currentStatus === 'generating' && t('nanoBanana.generating', {}, 'Starting image generation...')}
                    {conversation.currentStatus === 'polling' && t('nanoBanana.waitingForResult', {}, 'Generating your image...')}
                  </div>
                  <div className="nanobanana-dialog__message-progress">
                    <div
                      className="nanobanana-dialog__message-progress-bar"
                      style={{ width: `${conversation.progress}%` }}
                    />
                  </div>
                  <div className="nanobanana-dialog__message-progress-text">
                    {conversation.progress}% - {conversation.elapsedTime}s / ~{remainingTime}s {t('nanoBanana.remaining', {}, 'remaining')}
                  </div>
                </div>
              </div>
            )}

            <div ref={conversationEndRef} />
          </div>
        </div>

        {/* Footer - 输入区域 */}
        <div className="nanobanana-dialog__input-area">
          {/* 参考图列表（所有轮次通用） */}
          {conversation.currentReferences.length > 0 && (
            <div className="nanobanana-dialog__reference-row">
              {conversation.currentReferences.map((ref, idx) => (
                <div key={idx} className="nanobanana-dialog__message-reference nanobanana-dialog__message-reference--with-remove">
                  <img src={ref.preview} alt={`Reference ${idx + 1}`} />
                  <span>
                    {ref.source === 'uploaded'
                      ? t('nanoBanana.referenceImage', {}, 'Reference Image')
                      : t('nanoBanana.basedOnPrevious', {}, 'Based on previous image')}
                  </span>
                  <button
                    className="nanobanana-dialog__reference-remove-corner"
                    onClick={() => removeReference(idx)}
                    disabled={isGenerating}
                    title={t('nanoBanana.removeReference', {}, 'Remove reference image')}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {/* 添加更多参考图按钮（未满 5 张时显示） */}
              {conversation.currentReferences.length < MAX_REFERENCE_IMAGES && (
                <button
                  className="nanobanana-dialog__upload-new-reference"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isGenerating}
                  title={t('nanoBanana.uploadNewReference', {}, 'Upload new reference image')}
                >
                  <Upload size={14} />
                  <span>+</span>
                </button>
              )}
              {/* 全部清除按钮 */}
              {conversation.currentReferences.length > 1 && (
                <button
                  className="nanobanana-dialog__upload-new-reference"
                  onClick={clearAllReferences}
                  disabled={isGenerating}
                  title={t('nanoBanana.clearAllReferences', {}, 'Clear all reference images')}
                >
                  <X size={14} />
                  <span>{t('nanoBanana.clearAll', {}, 'Clear All')}</span>
                </button>
              )}
            </div>
          )}

          {/* 参数选择 */}
          <div className="nanobanana-dialog__input-params">
            <div className="nanobanana-dialog__input-param">
              <span className="nanobanana-dialog__input-param-label">{t('nanoBanana.aspectRatio', {}, 'Aspect Ratio')}</span>
              <select
                className="nanobanana-dialog__input-param-select"
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                disabled={isGenerating}
              >
                {ASPECT_RATIOS.map((ratio) => (
                  <option key={ratio.value} value={ratio.value}>
                    {ratio.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="nanobanana-dialog__input-param">
              <span className="nanobanana-dialog__input-param-label">{t('nanoBanana.imageSize', {}, 'Size')}</span>
              <select
                className="nanobanana-dialog__input-param-select"
                value={imageSize}
                onChange={(e) => setImageSize(e.target.value)}
                disabled={isGenerating}
              >
                {IMAGE_SIZES.map((size) => (
                  <option key={size.value} value={size.value}>
                    {size.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 隐藏的文件上传 input（始终存在，支持多选） */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/bmp"
              multiple
              onChange={handleImageUpload}
              style={{ display: 'none' }}
            />

            {/* 上传按钮（无参考图时显示） */}
            {conversation.currentReferences.length === 0 && (
              <button
                className="nanobanana-dialog__new-conversation-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={isGenerating}
                title={t('nanoBanana.uploadImage', {}, 'Upload Image')}
              >
                <Upload size={14} />
                <span>{t('nanoBanana.referenceImage', {}, 'Reference')}</span>
              </button>
            )}
          </div>

          {/* 输入框 */}
          <textarea
            ref={textareaRef}
            className="nanobanana-dialog__input-textarea"
            placeholder={
              isFirstRound
                ? t('nanoBanana.promptPlaceholder', {}, 'Describe the image you want to generate...')
                : t('nanoBanana.promptPlaceholderContinue', {}, 'Continue refining based on the previous image...')
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleGenerate();
              }
            }}
            disabled={isGenerating}
          />

          {/* 按钮组 */}
          <div className="nanobanana-dialog__input-actions">
            {!isFirstRound && (
              <button
                className="nanobanana-dialog__new-conversation-btn"
                onClick={handleNewConversation}
                disabled={isGenerating}
              >
                <RefreshCw size={14} />
                <span>{t('nanoBanana.newConversation', {}, 'New Chat')}</span>
              </button>
            )}
            <button
              className="nanobanana-dialog__continue-btn"
              onClick={handleGenerate}
              disabled={!prompt.trim() || isGenerating}
            >
              <ImageIcon size={14} />
              <span>
                {isFirstRound
                  ? t('nanoBanana.generate', {}, 'Generate Image')
                  : t('nanoBanana.continueGenerate', {}, 'Continue')}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NanoBananaDialog;
