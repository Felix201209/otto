/**
 * 主动服务右下角 Toast 提示组件。
 *
 * 监听 transport 层的 proactive_alert 帧，在屏幕右下角弹出小方框提示。
 * 自动堆叠、倒计时消失、支持优先级着色。
 */

import React, { useEffect, useRef, useState } from 'react';
import * as transport from '../transport.js';

interface Toast {
  id: string;
  ruleName: string;
  message: string;
  priority: 'low' | 'medium' | 'high';
  expiresAt: number;
}

const TOAST_DURATION_MS = 10_000; // 10 秒后消失
const MAX_TOASTS = 4;

export function ProactiveToast(): React.ReactElement | null {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const unsub = transport.onFrame((frame) => {
      if (frame.type !== 'proactive_alert') return;
      const { ruleName, message, priority } = frame.payload as {
        ruleName: string; message: string; priority: 'low' | 'medium' | 'high';
      };

      const toast: Toast = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        ruleName,
        message,
        priority,
        expiresAt: Date.now() + TOAST_DURATION_MS,
      };

      setToasts((prev) => [toast, ...prev].slice(0, MAX_TOASTS));
    });

    return () => { unsub(); };
  }, []);

  // 定期清理过期 toast
  useEffect(() => {
    timerRef.current = setInterval(() => {
      setToasts((prev) => prev.filter((t) => t.expiresAt > Date.now()));
    }, 500);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  if (toasts.length === 0) return null;

  const borderByPriority: Record<string, string> = {
    high: '2px solid #DC3545',
    medium: '2px solid #F0AD4E',
    low: '2px solid #6C757D',
  };

  const iconByPriority: Record<string, string> = {
    high: '⚠️',
    medium: '📌',
    low: '💬',
  };

  return (
    <div style={{
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column-reverse',
      gap: '10px',
      pointerEvents: 'none',
    }}>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          style={{
            background: 'var(--bg-surface, #1E1E2E)',
            border: borderByPriority[toast.priority] ?? '2px solid #6C757D',
            borderRadius: '10px',
            padding: '12px 16px',
            minWidth: '280px',
            maxWidth: '380px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
            pointerEvents: 'auto',
            animation: 'ottoToastIn 0.35s ease-out',
            cursor: 'pointer',
          }}
          onClick={() =>
            setToasts((prev) => prev.filter((t) => t.id !== toast.id))
          }
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '4px',
          }}>
            <span style={{ fontSize: '16px' }}>
              {iconByPriority[toast.priority] ?? '📌'}
            </span>
            <span style={{
              fontWeight: 600,
              fontSize: '12px',
              color: 'var(--text-muted, #999)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}>
              {toast.ruleName}
            </span>
          </div>
          <div style={{
            fontSize: '13px',
            lineHeight: '1.45',
            color: 'var(--text-primary, #EEE)',
          }}>
            {toast.message}
          </div>
        </div>
      ))}
      <style>{`
        @keyframes ottoToastIn {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
