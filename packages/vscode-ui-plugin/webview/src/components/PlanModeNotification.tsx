/**
 * Plan Mode Notification Component
 * Plan模式禁用通知 - 告知用户不能执行修改操作
 *
 * @license Apache-2.0
 * Copyright 2025 Easy Code
 */

import React, { useState, useEffect } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { useTranslation } from '../hooks/useTranslation';
import './PlanModeNotification.css';

interface PlanModeNotificationProps {
  blockedTools: string[];
  visible: boolean;
  onDismiss: () => void;
}

export const PlanModeNotification: React.FC<PlanModeNotificationProps> = ({
  blockedTools,
  visible,
  onDismiss
}) => {
  const { t } = useTranslation();
  const [isShowing, setIsShowing] = useState(visible);

  useEffect(() => {
    setIsShowing(visible);

    if (visible) {
      // 自动关闭通知（可选，5秒后关闭）
      const timer = setTimeout(() => {
        setIsShowing(false);
        onDismiss();
      }, 5000);

      return () => clearTimeout(timer);
    }
  }, [visible, onDismiss]);

  if (!isShowing) {
    return null;
  }

  const handleDismiss = () => {
    setIsShowing(false);
    onDismiss();
  };

  return (
    <div className="plan-mode-notification">
      <div className="notification-content">
        <AlertCircle size={18} className="notification-icon" />
        <div className="notification-text">
          <div className="notification-title">
            {t('plan.mode.blockedToolsMessage', {}, '🚫 Plan mode - modification tools disabled')}
          </div>
          <div className="notification-tools">
            {blockedTools.join(', ')}
          </div>
          <div className="notification-hint">
            {t('plan.mode.useHintPrefix', {}, 'Use ')}
            <span className="hint-command">/plan off</span>
            {t('plan.mode.useHintSuffix', {}, ' to exit Plan mode and enable all tools')}
          </div>
        </div>
      </div>
      <button
        className="notification-close"
        onClick={handleDismiss}
        aria-label="Close notification"
        title="Close"
      >
        <X size={16} />
      </button>
    </div>
  );
};

export default PlanModeNotification;
