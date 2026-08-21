/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 *
 * Private deployment bootstrap coordinator.
 *
 * The desktop only supplies the enterprise server URL. The server keeps the
 * one-time bootstrap secret and uses it to claim a Control-signed License.
 * This module also exposes a credential-free readiness projection covering
 * the rest of the private deployment surface, not License alone.
 */

import type {
  DeploymentLicenseView,
  PrivateDeploymentRuntimeConfiguration,
  PrivateDeploymentStatus,
} from '../commercial_control/deploymentTypes.js';

const USABLE_LICENSE_STATES = new Set(['active', 'expiring', 'grace']);

export type PrivateDeploymentBootstrapPhase =
  | 'idle'
  | 'not_configured'
  | 'claiming'
  | 'activated'
  | 'failed';

export type PrivateDeploymentReadinessState =
  | 'ready'
  | 'ready_for_identity'
  | 'configuring'
  | 'degraded'
  | 'blocked';

export type PrivateDeploymentStepState =
  | 'ready'
  | 'configuring'
  | 'waiting_for_user'
  | 'action_required'
  | 'disabled';

export type PrivateDeploymentStepId =
  | 'deployment_identity'
  | 'license'
  | 'modules'
  | 'model_and_credits'
  | 'storage'
  | 'federation'
  | 'updates'
  | 'telemetry'
  | 'account_identity';

export interface PrivateDeploymentReadinessStep {
  id: PrivateDeploymentStepId;
  state: PrivateDeploymentStepState;
  required: boolean;
  message: string;
}

export interface PrivateDeploymentBootstrapSnapshot {
  phase: PrivateDeploymentBootstrapPhase;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  errorCode: string | null;
}

export interface PrivateDeploymentReadiness {
  state: PrivateDeploymentReadinessState;
  canAuthenticate: boolean;
  canUseLicensedFeatures: boolean;
  bootstrap: PrivateDeploymentBootstrapSnapshot;
  steps: PrivateDeploymentReadinessStep[];
}

export interface PrivateDeploymentBootstrapClaimConfig {
  controlUrl: string;
  bootstrapSecret: string;
  appVersion: string;
  buildCommit: string;
  publicOrigin?: string | null;
  deploymentKind?: string;
  allowInsecureLoopback?: boolean;
}

export interface PrivateDeploymentReadinessSource {
  deployment: PrivateDeploymentStatus;
  databaseReady: boolean;
  storageReady: boolean;
  federation: {
    enabled: boolean;
    configured: boolean;
    lastError?: unknown;
  };
  activeOrganizations: number;
  activeAccounts: number;
  runtimeConfiguration: PrivateDeploymentRuntimeConfiguration | null;
  bootstrap: PrivateDeploymentBootstrapSnapshot;
}

export interface PrivateDeploymentBootstrapServices {
  getReadinessSource(
    bootstrap: PrivateDeploymentBootstrapSnapshot,
  ): PrivateDeploymentReadinessSource;
  importDeploymentLicense(envelope: unknown): DeploymentLicenseView;
  refreshDeploymentLicenseLease(): Promise<{
    refreshed: boolean;
    skippedReason: string | null;
    error: string | null;
  }>;
  saveRuntimeConfiguration(
    configuration: PrivateDeploymentRuntimeConfiguration,
  ): void;
}

export interface PrivateDeploymentBootstrapCoordinator {
  prepare(): Promise<PrivateDeploymentReadiness>;
  readiness(): PrivateDeploymentReadiness;
  snapshot(): PrivateDeploymentBootstrapSnapshot;
}

interface ControlBootstrapResponse {
  status: 'activated' | 'already_activated';
  licenseEnvelope: unknown;
  capabilities?: Partial<PrivateDeploymentRuntimeConfiguration['capabilities']>;
  federationGatewayUrl?: string | null;
  modelGatewayUrl?: string | null;
  telemetryEndpoint?: string | null;
  updateDistributionId?: string | null;
}

function usableLicense(license: DeploymentLicenseView): boolean {
  return USABLE_LICENSE_STATES.has(license.status) && (
    !license.lease.required || license.lease.status === 'active'
  );
}

function step(
  id: PrivateDeploymentStepId,
  state: PrivateDeploymentStepState,
  required: boolean,
  message: string,
): PrivateDeploymentReadinessStep {
  return { id, state, required, message };
}

function capability(
  source: PrivateDeploymentReadinessSource,
  name: keyof PrivateDeploymentRuntimeConfiguration['capabilities'],
  fallback: boolean,
): boolean {
  return source.runtimeConfiguration?.capabilities[name] ?? fallback;
}

/** Build the user-visible, credential-free readiness projection. */
export function buildPrivateDeploymentReadiness(
  source: PrivateDeploymentReadinessSource,
): PrivateDeploymentReadiness {
  const license = source.deployment.license;
  const licenseUsable = usableLicense(license);
  const registered = license.id !== 'unlicensed' && license.status !== 'invalid';
  const bootstrapBusy = source.bootstrap.phase === 'claiming';
  const billingRequired = license.billingEnforcement === 'enforce';
  const billingReady = !billingRequired || (
    licenseUsable &&
    !source.deployment.billing.executionReceipt.registrationRequired &&
    !source.deployment.billing.executionReceipt.error
  );
  const modelGatewayEnabled = capability(source, 'modelGateway', billingRequired);
  const federationEnabled = capability(
    source,
    'federation',
    source.federation.enabled,
  );
  const updateEnabled = capability(source, 'updates', registered);
  const telemetryEnabled = capability(
    source,
    'telemetry',
    license.telemetryAllowed,
  );

  const steps: PrivateDeploymentReadinessStep[] = [
    step(
      'deployment_identity',
      registered ? 'ready' : bootstrapBusy ? 'configuring' : 'action_required',
      true,
      registered
        ? '部署身份已绑定到当前服务器'
        : bootstrapBusy
          ? '正在向 Otto Control 注册当前部署'
          : '部署尚未完成安全注册',
    ),
    step(
      'license',
      licenseUsable ? 'ready' : bootstrapBusy ? 'configuring' : 'action_required',
      true,
      licenseUsable
        ? `授权已生效，套餐为 ${license.plan}`
        : bootstrapBusy
          ? '正在领取并校验签名授权'
          : '授权缺失、过期或租约不可用',
    ),
    step(
      'modules',
      licenseUsable && license.modules.length > 0
        ? 'ready'
        : bootstrapBusy ? 'configuring' : 'action_required',
      true,
      licenseUsable && license.modules.length > 0
        ? `已按套餐启用 ${license.modules.length} 项功能模块`
        : '功能模块尚未获得执行层授权',
    ),
    step(
      'model_and_credits',
      !modelGatewayEnabled
        ? 'disabled'
        : billingReady && Boolean(source.runtimeConfiguration?.modelGatewayUrl)
          ? 'ready'
          : bootstrapBusy ? 'configuring' : 'action_required',
      modelGatewayEnabled,
      !modelGatewayEnabled
        ? '当前套餐未启用集中模型与积分网关'
        : billingReady && source.runtimeConfiguration?.modelGatewayUrl
          ? '模型用量计量、积分预占与签名执行收据已就绪'
          : '模型与积分网关地址或计费凭据尚未完成初始化',
    ),
    step(
      'storage',
      source.databaseReady && source.storageReady ? 'ready' : 'action_required',
      true,
      source.databaseReady && source.storageReady
        ? '数据库、附件存储与数据隔离已就绪'
        : '数据库或附件存储尚未通过就绪检查',
    ),
    step(
      'federation',
      !federationEnabled
        ? 'disabled'
        : source.federation.enabled && source.federation.configured
          ? 'ready'
          : bootstrapBusy ? 'configuring' : 'action_required',
      false,
      !federationEnabled
        ? '当前部署未启用跨服务器协作'
        : source.federation.enabled && source.federation.configured
          ? '跨私有服务器消息、附件与 A2A 网关已就绪'
          : '联邦网关已获授权，但服务器连接尚未完成',
    ),
    step(
      'updates',
      !updateEnabled
        ? 'disabled'
        : licenseUsable && Boolean(source.runtimeConfiguration?.updateDistributionId)
          ? 'ready'
          : bootstrapBusy ? 'configuring' : 'action_required',
      false,
      !updateEnabled
        ? '当前部署未启用集中更新通道'
        : licenseUsable && source.runtimeConfiguration?.updateDistributionId
          ? '签名更新策略与版本通道已就绪'
          : '签名更新通道尚未完成初始化',
    ),
    step(
      'telemetry',
      !telemetryEnabled
        ? 'disabled'
        : source.deployment.telemetry.endpoint ? 'ready' : 'action_required',
      false,
      !telemetryEnabled
        ? '运行数据上报已按套餐或客户策略关闭'
        : source.deployment.telemetry.endpoint
          ? '仅运行与用量数据的加密遥测队列已就绪'
          : '遥测已启用，但接收地址尚未配置',
    ),
    step(
      'account_identity',
      source.activeAccounts > 0 ? 'ready' : 'waiting_for_user',
      true,
      source.activeAccounts > 0
        ? '可恢复已有账号，或使用本服务器账号登录'
        : '服务器已就绪，请创建首个企业账号或登录身份',
    ),
  ];

  const requiredBlocked = steps.some(
    (item) => item.required && item.state === 'action_required',
  );
  const optionalAttention = steps.some(
    (item) => !item.required && item.state === 'action_required',
  );
  const waitingForIdentity = steps.some(
    (item) => item.id === 'account_identity' && item.state === 'waiting_for_user',
  );
  const state: PrivateDeploymentReadinessState = bootstrapBusy
    ? 'configuring'
    : requiredBlocked
      ? 'blocked'
      : waitingForIdentity
        ? 'ready_for_identity'
        : optionalAttention
          ? 'degraded'
          : 'ready';

  return {
    state,
    canAuthenticate: !requiredBlocked && !bootstrapBusy,
    canUseLicensedFeatures: licenseUsable && source.databaseReady && source.storageReady,
    bootstrap: { ...source.bootstrap },
    steps,
  };
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeOptionalHttpsUrl(
  value: unknown,
  allowInsecureLoopback = false,
): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('bootstrap_configuration_invalid');
  const parsed = new URL(value);
  const loopback = parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' || parsed.hostname === '::1';
  if (
    (parsed.protocol !== 'https:' &&
      !(allowInsecureLoopback && loopback && parsed.protocol === 'http:')) ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== '/' && parsed.pathname !== '')
  ) {
    throw new Error('bootstrap_configuration_invalid');
  }
  return parsed.origin;
}

function normalizeOptionalHttpsEndpoint(
  value: unknown,
  allowInsecureLoopback = false,
): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('bootstrap_configuration_invalid');
  const parsed = new URL(value);
  const loopback = parsed.hostname === '127.0.0.1' ||
    parsed.hostname === 'localhost' || parsed.hostname === '::1';
  if (
    (parsed.protocol !== 'https:' &&
      !(allowInsecureLoopback && loopback && parsed.protocol === 'http:')) ||
    parsed.username || parsed.password || parsed.search || parsed.hash
  ) {
    throw new Error('bootstrap_configuration_invalid');
  }
  return parsed.toString();
}

export function normalizeControlBootstrapResponse(
  raw: unknown,
  controlOrigin: string,
  activatedAt: string,
  allowInsecureLoopback = false,
): {
  response: ControlBootstrapResponse;
  configuration: PrivateDeploymentRuntimeConfiguration;
} {
  const body = safeObject(raw);
  if (body.status !== 'activated' && body.status !== 'already_activated') {
    throw new Error('bootstrap_response_invalid');
  }
  if (!body.licenseEnvelope || typeof body.licenseEnvelope !== 'object') {
    throw new Error('bootstrap_license_missing');
  }
  const rawCapabilities = safeObject(body.capabilities);
  const booleanCapability = (name: string, fallback: boolean): boolean =>
    typeof rawCapabilities[name] === 'boolean'
      ? rawCapabilities[name] as boolean
      : fallback;
  const configuration: PrivateDeploymentRuntimeConfiguration = {
    controlOrigin,
    capabilities: {
      billing: booleanCapability('billing', true),
      telemetry: booleanCapability('telemetry', true),
      federation: booleanCapability('federation', false),
      updates: booleanCapability('updates', true),
      modelGateway: booleanCapability('modelGateway', true),
      storage: booleanCapability('storage', true),
    },
    federationGatewayUrl: normalizeOptionalHttpsUrl(
      body.federationGatewayUrl,
      allowInsecureLoopback,
    ),
    modelGatewayUrl: normalizeOptionalHttpsUrl(
      body.modelGatewayUrl,
      allowInsecureLoopback,
    ),
    telemetryEndpoint: normalizeOptionalHttpsEndpoint(
      body.telemetryEndpoint,
      allowInsecureLoopback,
    ),
    updateDistributionId:
      typeof body.updateDistributionId === 'string' && body.updateDistributionId.trim()
        ? body.updateDistributionId.trim().slice(0, 120)
        : null,
    activatedAt,
  };
  return {
    response: {
      status: body.status,
      licenseEnvelope: body.licenseEnvelope,
      capabilities: configuration.capabilities,
      federationGatewayUrl: configuration.federationGatewayUrl,
      modelGatewayUrl: configuration.modelGatewayUrl,
      telemetryEndpoint: configuration.telemetryEndpoint,
      updateDistributionId: configuration.updateDistributionId,
    },
    configuration,
  };
}

function normalizeControlOrigin(
  value: string,
  allowInsecureLoopback = false,
): string {
  const origin = normalizeOptionalHttpsUrl(value, allowInsecureLoopback);
  if (!origin) throw new Error('bootstrap_control_url_missing');
  return origin;
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^[a-z0-9_]{3,80}$/u.test(message)) return message;
  return 'bootstrap_failed';
}

/**
 * Create an idempotent coordinator. Concurrent prepare calls share one claim,
 * and no client-controlled data is forwarded to Control.
 */
export function createPrivateDeploymentBootstrapCoordinator(
  services: PrivateDeploymentBootstrapServices,
  config: PrivateDeploymentBootstrapClaimConfig | null,
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
    retryAfterMs?: number;
  } = {},
): PrivateDeploymentBootstrapCoordinator {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let claimConfig = config ? { ...config } : null;
  const forgetClaimConfig = () => {
    if (claimConfig) claimConfig.bootstrapSecret = '';
    claimConfig = null;
  };
  let current: PrivateDeploymentBootstrapSnapshot = {
    phase: 'idle',
    lastAttemptAt: null,
    lastSuccessAt: null,
    errorCode: null,
  };
  let running: Promise<PrivateDeploymentReadiness> | null = null;

  const readiness = () => buildPrivateDeploymentReadiness(
    services.getReadinessSource(current),
  );

  const prepareOnce = async (): Promise<PrivateDeploymentReadiness> => {
    const beforeSource = services.getReadinessSource(current);
    const before = beforeSource.deployment.license;
    if (usableLicense(before) && (beforeSource.runtimeConfiguration || !claimConfig)) {
      forgetClaimConfig();
      current = {
        ...current,
        phase: 'activated',
        lastSuccessAt: current.lastSuccessAt ?? new Date(now()).toISOString(),
        errorCode: null,
      };
      return readiness();
    }
    const previousAttempt = current.lastAttemptAt
      ? Date.parse(current.lastAttemptAt)
      : Number.NaN;
    if (
      current.phase === 'failed' && Number.isFinite(previousAttempt) &&
      now() - previousAttempt < Math.max(5_000, options.retryAfterMs ?? 30_000)
    ) {
      return readiness();
    }
    if (!claimConfig) {
      current = {
        ...current,
        phase: 'not_configured',
        errorCode: 'bootstrap_not_configured',
      };
      return readiness();
    }
    const activeConfig = claimConfig;
    const attemptAtMs = now();
    const attemptedAt = new Date(attemptAtMs).toISOString();
    current = {
      ...current,
      phase: 'claiming',
      lastAttemptAt: attemptedAt,
      errorCode: null,
    };
    try {
      const controlOrigin = normalizeControlOrigin(
        activeConfig.controlUrl,
        activeConfig.allowInsecureLoopback,
      );
      if (activeConfig.bootstrapSecret.trim().length < 32) {
        throw new Error('bootstrap_secret_invalid');
      }
      const source = services.getReadinessSource(current);
      const response = await fetchImpl(
        `${controlOrigin}/v1/deployment-enrollments/claim`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${activeConfig.bootstrapSecret}`,
            'content-type': 'application/json',
            'user-agent': 'Otto-Private-Deployment-Bootstrap/1',
          },
          body: JSON.stringify({
            version: 1,
            deploymentId: source.deployment.deploymentId,
            machineFingerprint: source.deployment.machineFingerprint,
            appVersion: activeConfig.appVersion,
            buildCommit: activeConfig.buildCommit,
            publicOrigin: activeConfig.publicOrigin || null,
            deploymentKind: activeConfig.deploymentKind || 'self-hosted',
          }),
          signal: AbortSignal.timeout(
            Math.max(1_000, options.timeoutMs ?? 15_000),
          ),
        },
      );
      if (!response.ok) {
        throw new Error(`bootstrap_control_${response.status}`);
      }
      const normalized = normalizeControlBootstrapResponse(
        await response.json(),
        controlOrigin,
        attemptedAt,
        activeConfig.allowInsecureLoopback,
      );
      services.importDeploymentLicense(normalized.response.licenseEnvelope);
      services.saveRuntimeConfiguration(normalized.configuration);
      const license = services.getReadinessSource(current).deployment.license;
      if (license.lease.required) {
        const lease = await services.refreshDeploymentLicenseLease();
        if (lease.error) throw new Error('bootstrap_lease_failed');
      }
      forgetClaimConfig();
      current = {
        phase: 'activated',
        lastAttemptAt: attemptedAt,
        lastSuccessAt: new Date(now()).toISOString(),
        errorCode: null,
      };
      return readiness();
    } catch (error) {
      current = {
        ...current,
        phase: 'failed',
        errorCode: errorCode(error),
      };
      return readiness();
    }
  };

  return {
    prepare(): Promise<PrivateDeploymentReadiness> {
      running ??= prepareOnce().finally(() => {
        running = null;
      });
      return running;
    },
    readiness,
    snapshot: () => ({ ...current }),
  };
}

export function startPrivateDeploymentBootstrapRuntime(
  coordinator: Pick<PrivateDeploymentBootstrapCoordinator, 'prepare'>,
  options: {
    intervalMs?: number;
    initialDelayMs?: number;
    onError?: (error: unknown) => void;
  } = {},
): () => void {
  const intervalMs = Math.max(30_000, options.intervalMs ?? 120_000);
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await coordinator.prepare();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
    }
  };
  const initial = setTimeout(() => void tick(), options.initialDelayMs ?? 500);
  initial.unref();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(timer);
  };
}
