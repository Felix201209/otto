/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export type ParkPublicationKind = 'announcement' | 'satisfaction';

export interface ParkPublicationView {
  id: string;
  kind: ParkPublicationKind;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  submittedAt: string | null;
  responseData: Record<string, string> | null;
  recipientCount: number;
  readCount: number;
}

export interface ParkAnnouncementResultView {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  recipientCount: number;
  readCount: number;
}

export interface ParkSurveyResultView {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  recipientCount: number;
  submittedCount: number;
  responses: Array<{
    accountId: string;
    accountName: string;
    submittedAt: string;
    responseData: Record<string, string>;
  }>;
}
