/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export interface ModelUsageAccount {
  id: string;
  organizationId: string;
  name: string;
  username: string;
  status: 'active' | 'disabled';
}

export interface ModelUsageOrganization {
  id: string;
  status: 'active' | 'disabled';
}

export interface RecordModelUsageInput {
  accountId: string;
  sessionId: string;
  messageId: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AccountTokenUsageView {
  accountId: string;
  name: string;
  username: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  lastUsedAt: string | null;
}

export interface OrganizationUsageSummary {
  organizationId: string;
  periodDays: number;
  source: 'client_reported';
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  requestCount: number;
  byAccount: AccountTokenUsageView[];
}
