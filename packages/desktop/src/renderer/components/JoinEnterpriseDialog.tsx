/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { friendlyAuthError } from '../state/useEnterpriseAuth.js';
import { sanitizeOrganizationInviteCode } from './EnterpriseLoginPage.js';

export function JoinEnterpriseDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: (input: { inviteCode: string }) => Promise<void>;
}): React.JSX.Element | null {
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const titleId = `${useId()}-title`;
  const descriptionId = `${useId()}-description`;
  const valid = inviteCode.replace(/[^A-HJ-NP-Za-km-z2-9]/g, '').length === 12;

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement;
    setInviteCode('');
    setBusy(false);
    setError(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      const trigger = triggerRef.current;
      if (trigger instanceof HTMLElement && document.contains(trigger)) trigger.focus();
    };
  }, [open]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ inviteCode });
    } catch (cause) {
      setError(friendlyAuthError(cause));
      setBusy(false);
    }
  };

  return (
    <div
      className="otto-confirm-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <form
        className="otto-confirm otto-join-enterprise"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="otto-confirm__title" id={titleId}>升级为企业版</h2>
        <p className="otto-confirm__message" id={descriptionId}>
          输入老板或管理员提供的企业邀请码。成功后将立即切换到对应企业；
          出于企业数据隔离，原个人空间对话不会自动带入企业。
        </p>
        <label className="otto-join-enterprise__field">
          <span>企业邀请码</span>
          <input
            ref={inputRef}
            aria-label="企业邀请码"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            maxLength={14}
            value={inviteCode}
            disabled={busy}
            onChange={(event) => {
              setInviteCode(sanitizeOrganizationInviteCode(event.target.value));
              setError(null);
            }}
            placeholder="Aa3B-k9Pq-Z7xY"
          />
        </label>
        {error ? <div className="otto-join-enterprise__error" role="alert">{error}</div> : null}
        <div className="otto-confirm__actions">
          <button
            type="button"
            className="otto-confirm__cancel"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="submit"
            className="otto-confirm__confirm"
            disabled={!valid || busy}
          >
            {busy ? '正在加入…' : '加入企业'}
          </button>
        </div>
      </form>
    </div>
  );
}
