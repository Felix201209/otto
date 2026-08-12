/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export type TicketHistoryAction =
  | 'created'
  | 'accept'
  | 'release'
  | 'respond'
  | 'transfer'
  | 'complete'
  | 'confirm';

export interface TicketHistoryEntry {
  id: string;
  action: TicketHistoryAction;
  statusBefore: string | null;
  statusAfter: string;
  responseType: string | null;
  responseText: string | null;
  createdAt: string;
  actor: { id: string; name: string } | null;
}

export interface TicketNotificationView {
  channel: 'otto' | 'sms' | 'feishu';
  event: string;
  status: 'sent' | 'failed' | 'skipped';
  detail: string | null;
  createdAt: string;
}

export interface TicketView {
  id: string;
  applicationNumber: string | null;
  parkId: string | null;
  serviceId: string;
  title: string;
  description: string;
  formData: Record<string, string>;
  targetTags: string[];
  status: string;
  category: string | null;
  location: string | null;
  urgency: string | null;
  contact: string | null;
  contactPhone: string | null;
  responseType: string | null;
  responseText: string | null;
  responseAt: string | null;
  /** 抢单成功者（实际处理人）。未接单时为 null。 */
  acceptedBy: { id: string; name: string } | null;
  /** 抢单后退回公共待办池的时间。 */
  releasedAt: string | null;
  /** 退回原因。 */
  releaseReason: string | null;
  createdAt: string;
  updatedAt: string;
  creator: { id: string; name: string; username: string };
  recipientCount: number;
  recipients: Array<{ id: string; name: string }>;
  deliveryStatus?: string;
  readAt?: string | null;
  creatorUpdateAt?: string | null;
  creatorUpdateReadAt?: string | null;
  isCreator?: boolean;
  isRecipient?: boolean;
  history: TicketHistoryEntry[];
  notifications: TicketNotificationView[];
}

export interface ParkTicketAccount {
  id: string;
  organizationId: string;
  employeeId: string | null;
  name: string;
  username: string;
  isAdmin: boolean;
  status: 'active' | 'disabled';
}

export interface ParkTicketPark {
  id: string;
  adminOrganizationId: string;
  status: 'active' | 'disabled';
}

export interface ParkTicketService {
  id: string;
  enabled: boolean;
}

export interface ParkTicketSpecialist {
  serviceId: string;
  accountId: string;
}

export interface CreateTicketInput {
  createdByAccountId: string;
  serviceId?: string;
  title: string;
  description: string;
  targetTags?: string[];
  formData?: Record<string, string>;
  category?: string;
  location?: string;
  urgency?: string;
  contact?: string;
  contactPhone?: string;
}

export interface UpdateTicketInput {
  ticketId: string;
  accountId: string;
  action:
    | 'respond'
    | 'accept'
    | 'release'
    | 'complete'
    | 'confirm'
    | 'respond_and_transfer';
  /** 退回公共待办池时的原因（仅 action 为 release 时使用）。 */
  releaseReason?: string;
  responseType?: string;
  responseText?: string;
  transferAccountId?: string;
  transferDepartment?: string;
  transferNote?: string;
}

export interface RecordTicketNotificationInput {
  ticketId: string;
  recipientAccountId: string;
  channel: 'otto' | 'sms' | 'feishu';
  event: string;
  status: 'sent' | 'failed' | 'skipped';
  detail?: string | null;
}
