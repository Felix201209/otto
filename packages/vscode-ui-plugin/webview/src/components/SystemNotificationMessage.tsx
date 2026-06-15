/**
 * System Notification Message Component
 * Displays loop detection and compression notifications
 *
 * @license Apache-2.0
 */

import React from 'react';
import { ChatMessage } from '../types';
import { useTranslation } from '../hooks/useTranslation';
import './SystemNotificationMessage.css';

interface SystemNotificationMessageProps {
  message: ChatMessage;
}

export const SystemNotificationMessage: React.FC<SystemNotificationMessageProps> = ({ message }) => {
  const { t } = useTranslation();

  const getNotificationStyle = () => {
    switch (message.severity) {
      case 'error':
        return 'notification-error';
      case 'warning':
        return 'notification-warning';
      default:
        return 'notification-info';
    }
  };

  const getNotificationIcon = () => {
    switch (message.notificationType) {
      case 'loop_detected':
        return '🔄';
      case 'compression':
        return '✨';
      case 'warning':
        return '⚠️';
      default:
        return 'ℹ️';
    }
  };

  return (
    <div className={`system-notification ${getNotificationStyle()}${message.notificationInProgress ? ' notification-in-progress' : ''}`}>
      {/* 通知头部 - 图标/spinner + 标题 */}
      <div className="notification-header">
        {message.notificationInProgress ? (
          <span className="notification-spinner" aria-label="loading" role="status" />
        ) : (
          <span className="notification-icon" aria-hidden="true">{getNotificationIcon()}</span>
        )}
        <span className="notification-title">{message.notificationTitle}</span>
      </div>

      {/* 简要描述 */}
      {message.notificationDescription && (
        <div className="notification-description">
          {message.notificationDescription}
        </div>
      )}

      {/* 原因说明 */}
      {message.notificationReason && (
        <div className="notification-section">
          <div className="notification-label">Why</div>
          <div className="notification-content">
            {message.notificationReason.split('\n').map((line, index) =>
              line.trim() && <div key={index}>{line}</div>
            )}
          </div>
        </div>
      )}

      {/* 解决方案 */}
      {message.notificationAction && (
        <div className="notification-section">
          <div className="notification-label">Action</div>
          <div className="notification-content">
            {message.notificationAction.split('\n').map((line, index) =>
              line.trim() && <div key={index}>{line}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SystemNotificationMessage;
