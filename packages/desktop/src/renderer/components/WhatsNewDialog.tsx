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
    version: '1.6.4',
    date: '2026-07-11',
    items: [
      '已配置模型支持完整编辑：协议、接口地址、API Key、模型 ID、显示名、上下文窗口和启用状态均可修改',
      'API Key 留空会安全保留旧密钥；修改模型 ID 或地址会原子替换，不留下重复旧模型',
      '聊天框新增轻量语音输入：点击录音、再次点击停止，识别和可选润色后填回草稿，不自动发送',
      '新增手动、当前会话自动、所有会话自动三种授权模式；删除和高风险操作始终要求确认',
      'PPT 改为完整本地生成，不再依赖 Otto 云端地址、登录或上传，VS Code 扩展同步支持',
      '修复停止生成后工具卡片仍在处理、停止按钮无法恢复，以及本地用户权限误拦截等问题',
    ],
  },
  {
    version: '1.6.3',
    date: '2026-07-10',
    items: [
      '修复飞书首条消息错误返回 mock：每个飞书会话现在会先初始化隔离的真实 AI runtime 再处理消息',
      '飞书连接失败时改为显示真实初始化错误，不再用占位回复伪装连接成功',
      '对齐 EasyCode 的飞书会话隔离逻辑，并新增首消息与 server 端到端回归测试',
    ],
  },
  {
    version: '1.6.2',
    date: '2026-07-10',
    items: [
      '工作日志记录真实交付成果：可一键总结当前工作并保存 Markdown 报告，月历悬浮查看当天逐条明细',
      '会议结束后可主动生成会议纪要，园区报修支持飞书与短信逐级通知',
      '设置与诊断移除用量统计；暂时隐藏尚未开放的 Skill 与排行榜入口，减少空白页面',
      '修复工作日志日期、会话隔离、设置窗口 Esc 关闭及最新通知类型错误',
    ],
  },
  {
    version: '1.6.1',
    date: '2026-07-10',
    items: [
      '模型管理修复：已配置模型现在可以删除（列表内两击确认），删除当前生效模型会自动回退',
      '模型列表显示真实厂商（按接入域名识别：智谱 GLM / 阿里通义 / DeepSeek 等），不再一律显示 OpenAI',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-07-10',
    items: [
      '软件更新全自动：下载完成后点「立即安装并重启」，Otto 自动完成覆盖安装并重启（mac 免拖拽 / win 静默安装）',
      '设置与诊断中心改为悬浮大窗，对话保持在底层，点遮罩即可返回',
      '工作日志升级：月历视图（有记录的日期亮点，悬浮查看当天逐条明细）+「总结当下工作」一键生成当日工作报告',
      '顶栏新增黑/白底色一键切换按钮',
      '右侧面板：「智能体」更名「专家」，「自主开发」更名「企业AI自主开发」，移除聊天区悬浮小圆钮（入口统一在面板）',
      '诊断中心下架用量统计',
    ],
  },
  {
    version: '1.5.2',
    date: '2026-07-10',
    items: [
      '偏好设置新增「外观」：跟随系统 / 浅色 / 深色三选一，立即生效并记住选择',
      '检查更新遇到网络抖动时自动重试，减少"打开发布页"兜底出现的概率',
      '园区服务入口显示完整企业品牌名（随企业配置变化）',
    ],
  },
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
