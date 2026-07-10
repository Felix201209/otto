/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 「宏创AI园区服务」插件入口（聊天区右下角悬浮小钮 + 居中对话框）。
 *
 * 入口形态：默认只是一枚 36px 的图标小圆钮（弱化透明度，不抢聊天注意力），
 * hover 时提亮并横向展开露出「园区服务」标签；点击展开居中对话框。
 *
 * 对话框：半透明遮罩 + 居中卡片，六项园区服务入口（SVG 线性图标，与全局
 * 图标体系同风格）。点某项服务 → 关闭对话框，把该服务的请求模板注入底部
 * 输入框（insertComposerDraft，与右面板工具列表同一通路），补充细节后发送；
 * Esc / 点遮罩 / 右上 × 关闭。遮罩判定用 onMouseDown（对齐 ConfirmDialog：
 * 卡片内起手、遮罩上松手的拖拽不算关闭）。
 *
 * 无障碍：role=dialog + aria-modal + aria-labelledby；打开时焦点落第一个服务项，
 * 关闭后焦点还回触发小钮。
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { insertComposerDraft } from './Composer.js';
import {
  IconBuilding,
  IconBus,
  IconCalendarCheck,
  IconClose,
  IconIdBadge,
  IconPackage,
  IconUtensils,
  IconWrench,
} from './icons.js';

type IconComponent = (props: { size?: number; className?: string }) => React.JSX.Element;

interface ParkService {
  id: string;
  icon: IconComponent;
  name: string;
  desc: string;
  prompt: string;
}

/** 内置默认品牌（无企业定制配置时使用）。 */
const DEFAULT_BRAND = '宏创AI园区服务';
const DEFAULT_PARK = '宏创园区';

/** 自定义服务清单的图标轮换池（JSON 配置带不了图标，按序分配）。 */
const ICON_POOL: IconComponent[] = [
  IconIdBadge,
  IconCalendarCheck,
  IconWrench,
  IconPackage,
  IconBus,
  IconUtensils,
];

/** 内置默认服务清单：park 为园区称呼（企业定制时替换，如「XX园区」）。 */
function defaultServices(park: string): ParkService[] {
  return [
    {
      id: 'visitor',
      icon: IconIdBadge,
      name: '访客邀约',
      desc: '为来访客人登记入园',
      prompt: `帮我提交一条${park}访客邀约。访客姓名：；手机号：；来访日期与时间：；拜访事由：`,
    },
    {
      id: 'meeting-room',
      icon: IconCalendarCheck,
      name: '会议室预订',
      desc: '按人数时段找可用会议室',
      prompt: `帮我预订${park}会议室。参会人数：；日期：；时间段：；是否需要投屏/视频会议：`,
    },
    {
      id: 'it-repair',
      icon: IconWrench,
      name: 'IT 报修',
      desc: '设备网络故障提单',
      prompt: `帮我提交${park} IT 报修工单。故障位置：；故障描述：；紧急程度：`,
    },
    {
      id: 'admin',
      icon: IconPackage,
      name: '行政后勤',
      desc: '工位调整 · 物品领用 · 保洁',
      prompt: `帮我联系${park}行政后勤。需求类型（工位调整/物品领用/保洁/其他）：；具体说明：`,
    },
    {
      id: 'shuttle',
      icon: IconBus,
      name: '班车通勤',
      desc: '班车时刻与路线查询',
      prompt: `帮我查询${park}班车。出发地：；大致出发时间：`,
    },
    {
      id: 'dining',
      icon: IconUtensils,
      name: '餐饮服务',
      desc: '今日菜单与订餐',
      prompt: `帮我查看${park}今日餐厅菜单，并说明订餐需求：`,
    },
  ];
}

/**
 * 跨组件打开园区服务弹窗的事件通路（与 Composer 的 insertComposerDraft 同模式）：
 * 右侧面板「园区服务」入口深居另一棵组件树，为一条打开通路穿透 props 不值当。
 */
const PARK_OPEN_EVENT = 'otto:open-park-services';

/** 打开园区服务弹窗（右侧面板入口调用；ChatView 内挂载的 Plugin 监听并展开）。 */
export function openParkServices(): void {
  window.dispatchEvent(new CustomEvent(PARK_OPEN_EVENT));
}

/**
 * 企业品牌名 hook（右侧面板入口卡片等处共用）：读 park-services.json 的
 * brandName，无配置用默认「宏创AI园区服务」。与 Plugin 内部读取相互独立
 * （幂等 IPC，读两次无副作用），避免为一个字符串穿 props。
 */
export function useParkBrand(): string {
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  useEffect(() => {
    let cancelled = false;
    void window.otto?.parkConfig?.().then((cfg) => {
      if (!cancelled && cfg?.brandName) setBrand(cfg.brandName);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return brand;
}

export function ParkServicesPlugin({
  showFab = true,
}: {
  /** 是否显示右下角悬浮小钮（无活跃会话时隐藏，但弹窗监听常驻——右侧面板入口仍可打开）。 */
  showFab?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // 企业定制：品牌名 / 园区称呼 / 服务清单（~/.otto-user/park-services.json，
  // 经 preload parkConfig() 读取；无配置 = 内置宏创默认）。
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  const [services, setServices] = useState<ParkService[]>(() =>
    defaultServices(DEFAULT_PARK),
  );
  const fabRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const uid = useId();
  const titleId = `${uid}-title`;

  useEffect(() => {
    let cancelled = false;
    void window.otto?.parkConfig?.().then((cfg) => {
      if (cancelled || !cfg) return;
      if (cfg.brandName) setBrand(cfg.brandName);
      if (cfg.services && cfg.services.length > 0) {
        // 完全覆盖：图标从内置池按序轮换。
        setServices(
          cfg.services.map((s, i) => ({
            id: `custom-${i}`,
            icon: ICON_POOL[i % ICON_POOL.length],
            name: s.name,
            desc: s.desc,
            prompt: s.prompt,
          })),
        );
      } else if (cfg.parkName) {
        // 只改园区称呼：默认六项模板换名。
        setServices(defaultServices(cfg.parkName));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 打开：焦点落第一个服务项；关闭：焦点还回触发小钮。
  useEffect(() => {
    if (open) firstItemRef.current?.focus();
    else fabRef.current?.focus();
  }, [open]);

  // 右侧面板「园区服务」入口经自定义事件打开本弹窗。
  useEffect(() => {
    const onOpen = (): void => setOpen(true);
    window.addEventListener(PARK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(PARK_OPEN_EVENT, onOpen);
  }, []);

  const pick = (prompt: string): void => {
    setOpen(false);
    insertComposerDraft(prompt);
  };

  const onDialogKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <>
      {showFab ? (
      <button
        ref={fabRef}
        type="button"
        className="otto-park-fab"
        onClick={() => setOpen(true)}
        title={brand}
        aria-label={brand}
      >
        <IconBuilding size={17} className="otto-park-fab__icon" />
        {/* 于总：右下角必须带企业品牌名（默认「宏创AI园区服务」，随 brandName 配置变）。 */}
        <span className="otto-park-fab__label">{brand}</span>
      </button>
      ) : null}

      {open ? (
        <div
          className="otto-park-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onDialogKeyDown}
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
                <IconBuilding size={19} />
              </span>
              <div className="otto-park-dialog__headtext">
                <h2 className="otto-park-dialog__title" id={titleId}>
                  {brand}
                </h2>
                <div className="otto-park-dialog__subtitle">
                  选择服务，Otto 帮你办理——点击后可在输入框补充细节再发送。
                </div>
              </div>
              <button
                type="button"
                className="otto-park-dialog__close"
                onClick={() => setOpen(false)}
                aria-label="关闭"
              >
                <IconClose size={14} />
              </button>
            </div>
            <div className="otto-park-dialog__grid">
              {services.map((svc, i) => {
                const Icon = svc.icon;
                return (
                  <button
                    key={svc.id}
                    ref={i === 0 ? firstItemRef : undefined}
                    type="button"
                    className="otto-park-service"
                    onClick={() => pick(svc.prompt)}
                  >
                    <span className="otto-park-service__icon" aria-hidden>
                      <Icon size={17} />
                    </span>
                    <span className="otto-park-service__name">{svc.name}</span>
                    <span className="otto-park-service__desc">{svc.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
