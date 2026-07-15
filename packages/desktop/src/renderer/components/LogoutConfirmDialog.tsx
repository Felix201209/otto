/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ConfirmDialog } from './ConfirmDialog.js';

interface LogoutConfirmDialogProps {
  open: boolean;
  accountName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 退出登录必须经过独立确认，避免侧栏末端的高频操作被一次误触直接触发。
 * 焦点保护、Esc 取消和键盘陷阱复用通用 ConfirmDialog。
 */
export function LogoutConfirmDialog({
  open,
  busy,
  onCancel,
  onConfirm,
}: LogoutConfirmDialogProps): React.JSX.Element {
  return (
    <ConfirmDialog
      open={open}
      title="确认退出登录"
      message="退出后需要重新输入账号或手机号和密码。"
      confirmText={busy ? '正在退出…' : '确认退出'}
      cancelText="取消"
      danger
      onCancel={busy ? () => undefined : onCancel}
      onConfirm={() => {
        if (!busy) onConfirm();
      }}
    />
  );
}
