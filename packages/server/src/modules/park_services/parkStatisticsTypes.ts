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

export interface CreateParkDataStatisticsTaskInput {
  createdByAccountId: string;
  title: string;
  description: string;
  deadline: string;
  fields?: string[];
  templateName?: string | null;
  templateData?: string | null;
  organizationIds?: string[];
}

export interface ParkServiceUsageCount {
  serviceId: string;
  name: string;
  count: number;
  amountCny: number;
  recurringMonthlyCny: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
}

export interface ParkTenantServiceStatistics {
  organizationId: string;
  name: string;
  slug: string;
  status: 'active' | 'disabled';
  address: string | null;
  roomNumber: string | null;
  totalUses: number;
  totalAmountCny: number;
  recurringMonthlyCny: number;
  vehicleVisits: number;
  meetingRoomBookings: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  services: ParkServiceUsageCount[];
}

export interface ParkServiceStatisticsView {
  parkId: string;
  parkName: string;
  generatedAt: string;
  organizationCount: number;
  activeOrganizationCount: number;
  totalServiceUses: number;
  totalAmountCny: number;
  recurringMonthlyCny: number;
  vehicleVisits: number;
  meetingRoomBookings: number;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  services: ParkServiceUsageCount[];
  organizations: ParkTenantServiceStatistics[];
}
