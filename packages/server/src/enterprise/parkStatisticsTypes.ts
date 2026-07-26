export type ParkDataStatisticsAssignmentStatus =
  | 'pending'
  | 'delegated'
  | 'in_progress'
  | 'pending_review'
  | 'submitted'
  | 'returned'
  | 'overdue';

export interface ParkDataStatisticsAssignmentView {
  id: string;
  taskId: string;
  organizationId: string;
  organizationName: string;
  ceoAccountId: string;
  ceoName: string;
  assigneeAccountId: string | null;
  assigneeName: string | null;
  status: ParkDataStatisticsAssignmentStatus;
  responseData: Record<string, string> | null;
  returnReason: string | null;
  readAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  lastRemindedAt: string | null;
  updatedAt: string;
}

export interface ParkDataStatisticsTaskView {
  id: string;
  parkId: string;
  title: string;
  description: string;
  deadline: string;
  fields: string[];
  templateName: string | null;
  hasTemplate: boolean;
  status: 'published' | 'closed';
  createdAt: string;
  updatedAt: string;
  assignments: ParkDataStatisticsAssignmentView[];
}
