/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 设置与诊断中心的共用排版原子：面板骨架（标题/描述/动作区）、卡片、
 * 卡片行、状态圆点、徽章、空态。所有 hub 面板只用这几个原子拼装，
 * 保证 13 个面板的排版节奏完全一致。
 */

import React from 'react';

/** 面板骨架：标题 + 一句话描述在左，刷新/主操作等按钮固定在右上角。 */
export function Panel({
  title,
  desc,
  actions,
  children,
}: {
  title: string;
  desc: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="otto-hub__panel">
      <div className="otto-hub__panel-head">
        <div className="otto-hub__panel-titles">
          <h2 className="otto-hub__panel-title">{title}</h2>
          <div className="otto-hub__panel-desc">{desc}</div>
        </div>
        {actions ? <div className="otto-hub__panel-actions">{actions}</div> : null}
      </div>
      <div className="otto-hub__panel-body">{children}</div>
    </div>
  );
}

/** 分组卡片：行与行之间用 1px 分隔线，而不是每行各自一圈边框。 */
export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return <div className={'otto-hub__card' + (className ? ' ' + className : '')}>{children}</div>;
}

/** 卡片上方的小节标题（如「按模型」「按工具」）。 */
export function Caption({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="otto-hub__caption">{children}</div>;
}

export type DotTone = 'on' | 'busy' | 'off' | 'err';

/** 状态圆点：绿=就绪 / 黄=进行中 / 灰=未启用 / 红=断开。取代原来的 emoji。 */
export function Dot({ tone }: { tone: DotTone }): React.JSX.Element {
  return <span className={'otto-hub__dot otto-hub__dot--' + tone} aria-hidden />;
}

/** 小徽章：分类 / 来源 / 作用域等次要元信息。 */
export function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'accent' | 'danger';
}): React.JSX.Element {
  return (
    <span className={'otto-hub__badge' + (tone ? ' otto-hub__badge--' + tone : '')}>
      {children}
    </span>
  );
}

/** 空态：占位说明（可附一个动作按钮），居中放在虚线卡片里。 */
export function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="otto-hub__empty">{children}</div>;
}
