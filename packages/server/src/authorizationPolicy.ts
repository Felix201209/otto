import type { ToolCallConfirmationDetails } from 'otto-core';

export type RuntimeAuthorizationMode = 'manual' | 'auto';

type ConfirmationDetails = ToolCallConfirmationDetails | false;

/** 自动授权也绝不能绕过的交互与高风险操作。 */
export function isMandatoryConfirmation(details: ConfirmationDetails): boolean {
  if (!details) return false;
  return (
    (details as { riskLevel?: string }).riskLevel === 'high' ||
    Boolean((details as { warning?: string }).warning) ||
    (details as { type?: string }).type === 'delete' ||
    details.type === 'question' ||
    (details as { type?: string }).type === 'workflow'
  );
}

export function shouldRequestConfirmation(
  mode: RuntimeAuthorizationMode,
  details: ConfirmationDetails,
): boolean {
  if (!details) return false;
  return mode === 'manual' || isMandatoryConfirmation(details);
}
