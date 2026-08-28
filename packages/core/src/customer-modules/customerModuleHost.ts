import type { CustomerModuleCapability } from './customerModuleRunner.js';

export interface CustomerModuleHostAdapterResult {
  data: unknown;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  retryCount?: number;
  estimatedCostUsd?: number;
  commitStatus?: 'not-applicable' | 'pending' | 'committed' | 'recovered' | 'failed';
}

export interface CustomerModuleHostRequest {
  moduleId: string;
  version: string;
  capability: Exclude<CustomerModuleCapability, 'background'>;
  approvedCapabilities: readonly CustomerModuleCapability[];
  payload: unknown;
  externalWrite?: boolean;
  idempotencyKey?: string;
}

export interface CustomerModuleHostAuditEvent {
  type: 'customer_module.host_call';
  origin: string;
  capability: CustomerModuleHostRequest['capability'];
  provider: string;
  inputTokens: number;
  outputTokens: number;
  retryCount: number;
  estimatedCostUsd: number;
  idempotencyKey?: string;
  commitStatus: NonNullable<CustomerModuleHostAdapterResult['commitStatus']>;
  outcome: 'success' | 'failed';
  error?: string;
}

export interface CustomerModuleHostV1 {
  request(input: CustomerModuleHostRequest): Promise<CustomerModuleHostAdapterResult>;
}

export class CustomerModuleHostBroker implements CustomerModuleHostV1 {
  constructor(private readonly options: {
    invoke(input: Omit<CustomerModuleHostRequest, 'approvedCapabilities'>): Promise<CustomerModuleHostAdapterResult>;
    onAudit?(event: CustomerModuleHostAuditEvent): void;
  }) {}

  async request(input: CustomerModuleHostRequest): Promise<CustomerModuleHostAdapterResult> {
    if (!input.approvedCapabilities.includes(input.capability)) {
      throw new Error(`customer module capability is not approved: ${input.capability}`);
    }
    if (input.externalWrite && !input.idempotencyKey?.trim()) {
      throw new Error('customer module external write requires an idempotency key');
    }
    const { approvedCapabilities: _approved, ...adapterInput } = input;
    try {
      const result = await this.options.invoke(adapterInput);
      this.audit(input, result, 'success');
      return result;
    } catch (error) {
      this.audit(input, { data: null, commitStatus: 'failed' }, 'failed', 'host capability call failed');
      throw error;
    }
  }

  private audit(
    input: CustomerModuleHostRequest,
    result: CustomerModuleHostAdapterResult,
    outcome: CustomerModuleHostAuditEvent['outcome'],
    error?: string,
  ): void {
    this.options.onAudit?.({
      type: 'customer_module.host_call', origin: `customer-module:${input.moduleId}@${input.version}`,
      capability: input.capability, provider: result.provider ?? 'local', inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0, retryCount: result.retryCount ?? 0,
      estimatedCostUsd: result.estimatedCostUsd ?? 0, outcome,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      commitStatus: result.commitStatus ?? 'not-applicable', ...(error ? { error: error.slice(0, 500) } : {}),
    });
  }
}
