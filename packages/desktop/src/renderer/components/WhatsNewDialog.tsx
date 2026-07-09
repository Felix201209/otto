/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「新版本更新说明」首启弹窗。
 *
 * 行为：App 启动后读 app 版本（preload appVersion()）与 localStorage 里
 * 上次已读版本比对——不一致且 CHANGELOG 里有当前版本条目 → 弹居中对话框
 * 列出本版新增/改动；点「知道了」或 Esc/遮罩关闭并记录已读，下次启动不再弹。
 *
 * CHANGELOG 随每次发版在此文件顶部补一段（最新在前）——发布流程的一部分。
 */

import React, { useEffect, useId, useState } from 'react';
import { IconSparkle, IconClose } from './icons.js';

interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

/** 版本更新说明（最新在前；只有列在这里的版本会触发弹窗）。 */
const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.5.0',
    date: '2026-07-09',
    items: [
      '全新品牌 IP「Otto 小刺猬」上线：应用图标与对话头像焕新——刺猬是企业，每根刺尖连接一位员工的 Otto',
      '右侧面板新增「园区 AI 服务」入口（自主开发上方）：访客邀约 / 会议室 / 报修 / 班车 / 餐饮一键直达',
      '右侧面板新增 排行榜 / Skill 市场 / 工作日志 三个 tab；顶栏部门岗位随飞书自动同步',
      '升级后首次启动自动展示更新说明（本弹窗）',
      '移除内置浏览器 tab；修复企业面板按钮无响应问题',
    ],
  },
  {
    version: '1.4.4',
    date: '2026-07-09',
    items: [
      '右侧面板新增「园区 AI 服务」入口（自主开发上方），访客邀约 / 会议室 / 报修 / 班车 / 餐饮一键直达',
      '右侧面板新增 排行榜 / Skill 市场 / 工作日志 三个 tab',
      '顶栏显示部门与岗位，随飞书组织架构自动同步',
      '自动生成的技能会以智能体形式出现在侧栏',
      '飞书开关现在直接控制真实守护进程',
      '移除内置浏览器 tab',
      '新增本弹窗：每次升级后首次启动自动展示更新内容',
    ],
  },
];

const SEEN_KEY = 'otto:whats-new-seen';

export function WhatsNewDialog(): React.JSX.Element | null {
  const [entry, setEntry] = useState<ChangelogEntry | null>(null);
  const uid = useId();
  const titleId = `${uid}-title`;

  useEffect(() => {
    let cancelled = false;
    void window.otto
      ?.appVersion()
      .then((ver) => {
        if (cancelled || !ver) return;
        let seen: string | null = null;
        try {
          seen = localStorage.getItem(SEEN_KEY);
        } catch {
          /* localStorage 不可用则每次都弹，可接受 */
        }
        if (seen === ver) return;
        const found = CHANGELOG.find((e) => e.version === ver);
        if (found) setEntry(found);
        else {
          // 本版没写更新说明（如开发构建）：静默记录，避免每次启动都查。
          try {
            localStorage.setItem(SEEN_KEY, ver);
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!entry) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(SEEN_KEY, entry.version);
    } catch {
      /* ignore */
    }
    setEntry(null);
  };

  return (
    <div
      className="otto-park-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          dismiss();
        }
      }}
    >
      <div
        className="otto-park-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="otto-park-dialog__head">
          <span className="otto-park-dialog__headicon" aria-hidden>
            <IconSparkle size={18} />
          </span>
          <div className="otto-park-dialog__headtext">
            <h2 className="otto-park-dialog__title" id={titleId}>
              Otto 更新到 v{entry.version}
            </h2>
            <div className="otto-park-dialog__subtitle">{entry.date} · 本次更新内容</div>
          </div>
          <button
            type="button"
            className="otto-park-dialog__close"
            onClick={dismiss}
            aria-label="关闭"
          >
            <IconClose size={14} />
          </button>
        </div>
        <ul className="otto-whatsnew__list">
          {entry.items.map((item, i) => (
            <li key={i} className="otto-whatsnew__item">
              {item}
            </li>
          ))}
        </ul>
        <div className="otto-whatsnew__actions">
          <button
            type="button"
            className="otto-hub__btn otto-hub__btn--primary"
            onClick={dismiss}
            autoFocus
          >
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
