/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useId, useState } from 'react';
import { IconClose } from './icons.js';

const FIRST_RUN_GUIDE_KEY = 'otto:first-run-guide:v1';

const STEPS = [
  {
    title: '欢迎使用 Otto',
    description:
      '聊天顶栏会显示当前企业、账号与服务端权威角色，发送消息前可先确认自己正以哪个身份工作。',
  },
  {
    title: '统一消息中心',
    description:
      '左下角“消息中心”集中展示本地、飞书和企业消息，可按未读状态或来源筛选并检索历史。',
  },
  {
    title: '端到端加密与设备安全',
    description:
      '在“设置与诊断中心—隐私与数据”管理设备批准、撤销、安全号码、恢复包与密钥透明日志。',
  },
] as const;

function hasCompletedGuide(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_GUIDE_KEY) === 'completed';
  } catch {
    return false;
  }
}

export function FirstRunGuide(): React.JSX.Element | null {
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(() => !hasCompletedGuide());
  const uid = useId();
  const titleId = `${uid}-title`;

  if (!open) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(FIRST_RUN_GUIDE_KEY, 'completed');
    } catch {
      // localStorage 不可用时只关闭当前弹窗。
    }
    setOpen(false);
  };

  const current = STEPS[step];
  return (
    <div
      className="otto-park-overlay otto-first-run"
      onKeyDown={(event) => {
        if (event.key === 'Escape') dismiss();
      }}
    >
      <div
        className="otto-park-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="otto-park-dialog__head">
          <div className="otto-park-dialog__headtext">
            <div className="otto-park-dialog__subtitle">
              首次使用导览 · {step + 1}/{STEPS.length}
            </div>
            <h2 className="otto-park-dialog__title" id={titleId}>
              {current.title}
            </h2>
          </div>
          <button
            type="button"
            className="otto-park-dialog__close"
            onClick={dismiss}
            aria-label="跳过导览"
          >
            <IconClose size={14} />
          </button>
        </div>
        <div className="otto-first-run__body">
          <p>{current.description}</p>
          <div className="otto-first-run__progress" aria-label="导览进度">
            {STEPS.map((item, index) => (
              <span
                className={index === step ? 'is-active' : ''}
                aria-label={`${item.title}${index === step ? '，当前步骤' : ''}`}
                key={item.title}
              />
            ))}
          </div>
        </div>
        <div className="otto-first-run__actions">
          <button
            type="button"
            className="otto-hub__btn"
            disabled={step === 0}
            onClick={() => setStep((currentStep) => currentStep - 1)}
          >
            上一步
          </button>
          <button
            type="button"
            className="otto-hub__btn otto-hub__btn--primary"
            onClick={() => {
              if (step === STEPS.length - 1) dismiss();
              else setStep((currentStep) => currentStep + 1);
            }}
            autoFocus
          >
            {step === STEPS.length - 1 ? '完成导览' : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}
