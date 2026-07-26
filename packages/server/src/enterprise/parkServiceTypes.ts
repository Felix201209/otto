export interface ParkServiceView {
  parkId: string;
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  updatedAt: string;
}

export interface ParkServiceSpecialistView {
  parkId: string;
  serviceId: string;
  accountId: string;
  name: string;
}
