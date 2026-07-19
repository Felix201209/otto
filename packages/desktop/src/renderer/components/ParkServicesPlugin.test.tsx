/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ParkServicesPlugin 单测（v1.6.0 起无悬浮小钮，入口=openParkServices 事件）：
 * 默认不渲染、事件打开、9 项服务 3×3、内置流程可本地演示、三种关闭、
 * 无障碍属性、企业定制覆盖。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup, act } from '@testing-library/react';
import { ParkServicesPlugin, openParkServices } from './ParkServicesPlugin.js';

afterEach(() => {
  cleanup();
  window.localStorage.removeItem('otto:local-repair-ticket');
});

/** 监听 Composer 注入事件（insertComposerDraft 派发的 CustomEvent）。 */
function listenDraft(): { texts: string[]; stop: () => void } {
  const texts: string[] = [];
  const handler = (e: Event): void => {
    texts.push((e as CustomEvent<string>).detail);
  };
  window.addEventListener('otto:composer-insert', handler);
  return { texts, stop: () => window.removeEventListener('otto:composer-insert', handler) };
}

/** 经右侧面板同款事件通路打开弹窗。 */
function openDialog(): void {
  act(() => {
    openParkServices();
  });
}

describe('ParkServicesPlugin', () => {
  it('默认不渲染任何可见节点（无悬浮小钮，弹窗关闭）', () => {
    const { container } = render(<ParkServicesPlugin />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.otto-park-fab')).toBeNull();
  });

  it('openParkServices 事件打开居中对话框，9 项服务齐全', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    expect(screen.getByRole('dialog')).toBeTruthy();
    for (const name of [
      '装修管理', '满意度调查', '园区公告', '停车位办理', '网络与电话', '会议室预约',
      '电卡充电', '客户报修', '来访车辆',
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.queryByText('行政后勤')).toBeNull();
    expect(screen.queryByText('班车通勤')).toBeNull();
    expect(screen.queryByText('餐饮服务')).toBeNull();
    expect(document.querySelectorAll('.otto-park-service')).toHaveLength(9);
    expect(Array.from(document.querySelectorAll('.otto-park-service__name')).slice(0, 2).map((node) => node.textContent)).toEqual(['园区公告', '满意度调查']);
  });

  it('内置服务先进入本地演示，可把真实填写请求交给 Otto', () => {
    const l = listenDraft();
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('会议室预约'));
    expect(screen.getByLabelText('会议室预约申请表')).toBeTruthy();
    expect(screen.getAllByText('会议服务专员')).toHaveLength(2);
    fireEvent.click(screen.getByText('改用 Otto 填写'));
    expect(l.texts).toHaveLength(1);
    expect(l.texts[0]).toContain('宏创园区会议室');
    expect(screen.queryByRole('dialog')).toBeNull();
    l.stop();
  });

  it('园区公告是接收端：园区发布后右下角弹窗，员工点击查看', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('园区公告'));
    expect(screen.getByText('本地模拟公告 · Otto 只作为企业接收端')).toBeTruthy();
    expect(screen.getByText('暂无新公告')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '模拟园区发布公告' }));
    expect(screen.getByLabelText('查看园区公告').textContent).toContain('下午临时停水通知');
    fireEvent.click(screen.getByLabelText('查看园区公告'));
    expect(screen.getByText('公告详情')).toBeTruthy();
    expect(screen.getByText('已读回执已记录')).toBeTruthy();
  });

  it('满意度调查是双向流程：园区发布问卷，员工填写并提交', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('满意度调查'));
    expect(screen.getByText('园区尚未发布问卷。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '模拟发布问卷' }));
    expect(screen.getByText('问卷已发布，等待员工提交。')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('总体满意度'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('重点关注'), { target: { value: '会议室环境' } });
    fireEvent.click(screen.getByRole('button', { name: '提交问卷' }));
    expect(screen.getByText('园区端已收到反馈')).toBeTruthy();
    expect(screen.getByText('4 分 · 会议室环境 · 已进入满意度汇总')).toBeTruthy();
  });

  it('报修演示使用申请表，并可切换维修端', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('客户报修'));
    const requestForm = screen.getByLabelText('客户报修申请表');
    expect(screen.getByText('Otto 填报提示')).toBeTruthy();
    fireEvent.submit(requestForm);
    fireEvent.click(screen.getByRole('button', { name: '维修端（张工）' }));
    expect(screen.getByText('网络维修主管张工')).toBeTruthy();
    expect(screen.getByText('某某会议室')).toBeTruthy();
  });

  it('报修类别选择其他时允许填写自定义类别', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('客户报修'));
    fireEvent.change(screen.getByLabelText('报修类别'), { target: { value: '其他' } });
    fireEvent.change(screen.getByLabelText('请填写其他类别'), { target: { value: '玻璃门损坏' } });
    fireEvent.submit(screen.getByLabelText('客户报修申请表'));
    fireEvent.click(screen.getByRole('button', { name: '维修端（张工）' }));
    expect(screen.getByText('玻璃门损坏')).toBeTruthy();
  });

  it('维修端收到 Otto 待处理提醒并可推进维修状态', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('客户报修'));
    fireEvent.submit(screen.getByLabelText('客户报修申请表'));
    fireEvent.click(screen.getByRole('button', { name: '维修端（张工）' }));
    expect(screen.getByRole('alertdialog', { name: 'Otto 待处理提醒' }).textContent).toContain('收到新的客户报修申请');
    fireEvent.click(screen.getByRole('button', { name: '打开维修处理表' }));
    fireEvent.click(screen.getByRole('button', { name: '接单并处理' }));
    fireEvent.click(screen.getByRole('button', { name: '提交维修完成' }));
    fireEvent.click(screen.getByRole('button', { name: '确认企业验收' }));
    expect(screen.getByText('已完成')).toBeTruthy();
  });

  it('维修端填写回复表，企业端收到回复弹窗', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('客户报修'));
    fireEvent.submit(screen.getByLabelText('客户报修申请表'));
    fireEvent.click(screen.getByRole('button', { name: '维修端（张工）' }));
    fireEvent.click(screen.getByRole('button', { name: '打开维修处理表' }));
    fireEvent.change(screen.getByLabelText('处理方式'), { target: { value: '远程指导' } });
    fireEvent.change(screen.getByLabelText('给报修人的说明'), { target: { value: '请先检查开关' } });
    fireEvent.submit(screen.getByLabelText('维修回复表'));
    fireEvent.click(screen.getByRole('button', { name: '企业端（报修人）' }));
    expect(screen.getByRole('alertdialog', { name: '维修人员回复提醒' }).textContent).toContain('请先检查开关');
  });

  it('其他园区服务使用各自的申请字段和处理选项', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    fireEvent.click(screen.getByText('装修管理'));
    expect(screen.getByText(/装修申请先核对施工范围/)).toBeTruthy();
    expect(screen.getByLabelText('装修管理申请表')).toBeTruthy();
    expect(screen.getByRole('button', { name: '提交装修管理申请' })).toBeTruthy();
  });

  it('Esc / 点遮罩 / 右上 × 都能关闭', () => {
    render(<ParkServicesPlugin />);

    openDialog();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    openDialog();
    const overlay = document.querySelector('.otto-park-overlay')!;
    fireEvent.mouseDown(overlay);
    expect(screen.queryByRole('dialog')).toBeNull();

    openDialog();
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('无障碍：dialog 具备 aria-modal 且由标题 labelledby（默认品牌名）', () => {
    render(<ParkServicesPlugin />);
    openDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBe('宏创AI园区服务');
  });

  it('企业定制：parkConfig 的 brandName/services 覆盖内置默认', async () => {
    const otto = {
      parkConfig: () =>
        Promise.resolve({
          brandName: '星火智慧园区服务',
          services: [{ name: '自定义服务A', desc: '描述A', prompt: '模板A' }],
        }),
    };
    (window as unknown as { otto: typeof otto }).otto = otto;
    try {
      render(<ParkServicesPlugin />);
      openDialog();
      expect(await screen.findByText('星火智慧园区服务')).toBeTruthy();
      expect(screen.getByText('自定义服务A')).toBeTruthy();
      expect(screen.queryByText('装修管理')).toBeNull();
    } finally {
      delete (window as unknown as { otto?: typeof otto }).otto;
    }
  });

  it('企业定制：只给 parkName 时默认服务换园区称呼', async () => {
    const otto = {
      parkConfig: () => Promise.resolve({ parkName: '星火园区' }),
    };
    (window as unknown as { otto: typeof otto }).otto = otto;
    try {
      const l = listenDraft();
      render(<ParkServicesPlugin />);
      openDialog();
      await screen.findByText('会议室预约');
      fireEvent.click(screen.getByText('会议室预约'));
      fireEvent.click(screen.getByText('改用 Otto 填写'));
      await new Promise((r) => setTimeout(r, 0));
      expect(l.texts[0]).toContain('星火园区会议室');
      l.stop();
    } finally {
      delete (window as unknown as { otto?: typeof otto }).otto;
    }
  });
});
