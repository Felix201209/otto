/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useId, useLayoutEffect, useMemo, useState } from 'react';
import type { UiMode } from '../uiModePreference.js';
import {
  IconAgent,
  IconClose,
  IconList,
  IconPaperclip,
  IconSettings,
  IconSparkle,
} from './icons.js';

type GuidePlacement = 'top' | 'right' | 'bottom' | 'left' | 'center';

interface GuideStep {
  title: string;
  description: string;
  tip: string;
  selector: string;
  placement: GuidePlacement;
  icon: React.ComponentType<{ size?: number }>;
}

interface TargetRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface CardPosition {
  top: number;
  left: number;
  placement: GuidePlacement;
}

const GUIDE_VERSION = 'v2';
const CARD_WIDTH = 380;
const CARD_HEIGHT = 320;
const CARD_GAP = 18;
const VIEWPORT_GAP = 16;
const SPOTLIGHT_GAP = 6;

const MODE_LABEL: Record<UiMode, string> = {
  conversational: '对话式 UI',
  work: '工作式 UI',
};

const STEPS: Record<UiMode, readonly GuideStep[]> = {
  conversational: [
    {
      title: '对话就是主工作区',
      description: '把目标、背景和期望结果告诉 Otto，后续资料与修改都在同一段对话中继续。',
      tip: '先说清楚要完成什么，Otto 会主动拆解任务并反馈进度。',
      selector: '.otto-main',
      placement: 'center',
      icon: IconSparkle,
    },
    {
      title: '从这里发起任务',
      description: '输入文字，也可以点击、拖拽或粘贴 Word、PDF、表格和图片。',
      tip: '复杂任务可以直接附上原始文件，不必先手工整理内容。',
      selector: '.otto-composer',
      placement: 'top',
      icon: IconPaperclip,
    },
    {
      title: '历史与企业入口都在左侧',
      description: '新建对话、查找历史、查看消息、进入组织架构和设置都集中在这里。',
      tip: '未读消息会保留红点，点击对应入口即可直达。',
      selector: '.otto-sidebar',
      placement: 'right',
      icon: IconList,
    },
  ],
  work: [
    {
      title: '对话与工作区并排协作',
      description: '中间处理当前任务，右侧持续展示专家和企业记忆，不必来回切页。',
      tip: '适合需要边沟通、边查看资料和工作状态的连续任务。',
      selector: '.otto-content-layout',
      placement: 'center',
      icon: IconSparkle,
    },
    {
      title: '右侧工作区会一直陪着你',
      description: '切换专家或查看企业记忆时，当前对话仍保留在中间。',
      tip: '点击右侧标签即可切换内容，工作区会保持展开。',
      selector: '.otto-right-panel',
      placement: 'left',
      icon: IconAgent,
    },
    {
      title: '从这里下达任务',
      description: '输入目标或直接加入文件，Otto 会结合右侧工作区中的资料继续处理。',
      tip: '拖入多个文件后可以一次说明它们之间的关系和最终产物。',
      selector: '.otto-composer',
      placement: 'top',
      icon: IconPaperclip,
    },
    {
      title: '左侧统一管理工作入口',
      description: '会话、消息、组织架构、设置与诊断都在左侧，不会挤占右侧工作区。',
      tip: '以后可在设置中切换界面，功能和数据不会改变。',
      selector: '.otto-sidebar',
      placement: 'right',
      icon: IconSettings,
    },
  ],
};

function guideStorageKey(mode: UiMode): string {
  return `otto:first-run-guide:${GUIDE_VERSION}:${mode}`;
}

function hasCompletedGuide(mode: UiMode): boolean {
  try {
    return localStorage.getItem(guideStorageKey(mode)) === 'completed';
  } catch {
    return false;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readTargetRect(selector: string): TargetRect | null {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

function calculateCardPosition(rect: TargetRect | null, preferred: GuidePlacement): CardPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const cardWidth = Math.min(CARD_WIDTH, viewportWidth - VIEWPORT_GAP * 2);
  const maxLeft = viewportWidth - cardWidth - VIEWPORT_GAP;
  const maxTop = viewportHeight - CARD_HEIGHT - VIEWPORT_GAP;

  if (!rect || viewportWidth <= 760) {
    return {
      top: clamp(viewportHeight - CARD_HEIGHT - VIEWPORT_GAP, VIEWPORT_GAP, maxTop),
      left: clamp((viewportWidth - cardWidth) / 2, VIEWPORT_GAP, maxLeft),
      placement: 'center',
    };
  }

  let placement = preferred;
  let left = rect.left + (rect.width - cardWidth) / 2;
  let top = rect.top + (rect.height - CARD_HEIGHT) / 2;

  if (placement === 'right') {
    left = rect.right + CARD_GAP;
    if (left + cardWidth > viewportWidth - VIEWPORT_GAP) {
      placement = 'left';
      left = rect.left - cardWidth - CARD_GAP;
    }
  } else if (placement === 'left') {
    left = rect.left - cardWidth - CARD_GAP;
    if (left < VIEWPORT_GAP) {
      placement = 'right';
      left = rect.right + CARD_GAP;
    }
  } else if (placement === 'top') {
    top = rect.top - CARD_HEIGHT - CARD_GAP;
    if (top < VIEWPORT_GAP) {
      placement = 'bottom';
      top = rect.bottom + CARD_GAP;
    }
  } else if (placement === 'bottom') {
    top = rect.bottom + CARD_GAP;
    if (top + CARD_HEIGHT > viewportHeight - VIEWPORT_GAP) {
      placement = 'top';
      top = rect.top - CARD_HEIGHT - CARD_GAP;
    }
  }

  return {
    top: clamp(top, VIEWPORT_GAP, maxTop),
    left: clamp(left, VIEWPORT_GAP, maxLeft),
    placement,
  };
}

export function FirstRunGuide({ mode }: { mode: UiMode }): React.JSX.Element | null {
  const steps = STEPS[mode];
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(() => !hasCompletedGuide(mode));
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const uid = useId();
  const titleId = `${uid}-title`;
  const current = steps[step];

  useEffect(() => {
    setStep(0);
    setOpen(!hasCompletedGuide(mode));
  }, [mode]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const updateTarget = (): void => setTargetRect(readTargetRect(current.selector));
    updateTarget();
    window.addEventListener('resize', updateTarget);
    return () => window.removeEventListener('resize', updateTarget);
  }, [current.selector, open]);

  const cardPosition = useMemo(
    () => calculateCardPosition(targetRect, current.placement),
    [current.placement, targetRect],
  );

  if (!open) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(guideStorageKey(mode), 'completed');
    } catch {
      // localStorage 不可用时只关闭当前导览。
    }
    setOpen(false);
  };

  const StepIcon = current.icon;
  const spotlightTop = targetRect ? Math.max(4, targetRect.top - SPOTLIGHT_GAP) : 0;
  const spotlightLeft = targetRect ? Math.max(4, targetRect.left - SPOTLIGHT_GAP) : 0;
  const spotlightStyle = targetRect
    ? {
        top: spotlightTop,
        left: spotlightLeft,
        width: Math.min(
          window.innerWidth - spotlightLeft - 4,
          targetRect.width + SPOTLIGHT_GAP * 2,
        ),
        height: Math.min(
          window.innerHeight - spotlightTop - 4,
          targetRect.height + SPOTLIGHT_GAP * 2,
        ),
      }
    : undefined;

  return (
    <div
      className={`otto-first-run${targetRect ? '' : ' is-fallback'}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') dismiss();
      }}
    >
      {targetRect ? (
        <div className="otto-first-run__spotlight" style={spotlightStyle} aria-hidden />
      ) : (
        <div className="otto-first-run__scrim" aria-hidden />
      )}
      <div
        className="otto-first-run__card"
        data-placement={cardPosition.placement}
        style={{ top: cardPosition.top, left: cardPosition.left }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="otto-first-run__head">
          <div className="otto-first-run__mode">
            <span className="otto-first-run__mode-icon" aria-hidden>
              <StepIcon size={16} />
            </span>
            <span>{MODE_LABEL[mode]} 导览</span>
          </div>
          <button
            type="button"
            className="otto-first-run__close"
            onClick={dismiss}
            aria-label="跳过导览"
            title="跳过导览"
          >
            <IconClose size={15} />
          </button>
        </div>

        <div className="otto-first-run__copy">
          <span className="otto-first-run__count">{String(step + 1).padStart(2, '0')}</span>
          <div>
            <h2 id={titleId}>{current.title}</h2>
            <p>{current.description}</p>
          </div>
        </div>

        <div className="otto-first-run__tip">
          <strong>使用建议</strong>
          <span>{current.tip}</span>
        </div>

        <div className="otto-first-run__footer">
          <div className="otto-first-run__progress" aria-label="导览进度">
            {steps.map((item, index) => (
              <button
                type="button"
                className={index === step ? 'is-active' : ''}
                aria-label={`前往第 ${index + 1} 步：${item.title}${index === step ? '，当前步骤' : ''}`}
                aria-current={index === step ? 'step' : undefined}
                key={item.title}
                onClick={() => setStep(index)}
              />
            ))}
          </div>
          <div className="otto-first-run__actions">
            {step > 0 ? (
              <button type="button" className="otto-first-run__back" onClick={() => setStep(step - 1)}>
                上一步
              </button>
            ) : (
              <button type="button" className="otto-first-run__back" onClick={dismiss}>
                稍后了解
              </button>
            )}
            <button
              type="button"
              className="otto-first-run__next"
              onClick={() => {
                if (step === steps.length - 1) dismiss();
                else setStep(step + 1);
              }}
              autoFocus
            >
              {step === steps.length - 1 ? '开始使用' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
