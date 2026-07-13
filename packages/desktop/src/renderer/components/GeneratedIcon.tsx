/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import agentAdminCoordination from '../assets/generated-icons/agent-admin-coordination.png';
import agentCeoDecisionBrief from '../assets/generated-icons/agent-ceo-decision-brief.png';
import agentCeoExecutiveMeeting from '../assets/generated-icons/agent-ceo-executive-meeting.png';
import agentCeoOperatingReview from '../assets/generated-icons/agent-ceo-operating-review.png';
import agentCeoStrategy from '../assets/generated-icons/agent-ceo-strategy.png';
import agentCeo from '../assets/generated-icons/agent-ceo.png';
import agentCustomerSuccess from '../assets/generated-icons/agent-customer-success.png';
import agentFinanceAnalysis from '../assets/generated-icons/agent-finance-analysis.png';
import agentFinanceBudget from '../assets/generated-icons/agent-finance-budget.png';
import agentFinanceReimbursement from '../assets/generated-icons/agent-finance-reimbursement.png';
import agentFinanceReport from '../assets/generated-icons/agent-finance-report.png';
import agentHrOnboarding from '../assets/generated-icons/agent-hr-onboarding.png';
import agentHrPerformance from '../assets/generated-icons/agent-hr-performance.png';
import agentHrRecruiting from '../assets/generated-icons/agent-hr-recruiting.png';
import agentMarketingCampaign from '../assets/generated-icons/agent-marketing-campaign.png';
import agentMarketingContent from '../assets/generated-icons/agent-marketing-content.png';
import agentMarketingPerformance from '../assets/generated-icons/agent-marketing-performance.png';
import agentMarketingResearch from '../assets/generated-icons/agent-marketing-research.png';
import agentMeetingFollowup from '../assets/generated-icons/agent-meeting-followup.png';
import agentMeetingInitiator from '../assets/generated-icons/agent-meeting-initiator.png';
import agentProductData from '../assets/generated-icons/agent-product-data.png';
import agentProductDelivery from '../assets/generated-icons/agent-product-delivery.png';
import agentProductRequirements from '../assets/generated-icons/agent-product-requirements.png';
import agentSalesLeadResearch from '../assets/generated-icons/agent-sales-lead-research.png';
import agentSalesMeetingFollowup from '../assets/generated-icons/agent-sales-meeting-followup.png';
import agentSalesSolution from '../assets/generated-icons/agent-sales-solution.png';
import agentTechnicalReview from '../assets/generated-icons/agent-technical-review.png';
import expertCopywriting from '../assets/generated-icons/expert-copywriting.png';
import expertDataviz from '../assets/generated-icons/expert-dataviz.png';
import expertDocument from '../assets/generated-icons/expert-document.png';
import expertMeeting from '../assets/generated-icons/expert-meeting.png';
import expertPdf from '../assets/generated-icons/expert-pdf.png';
import expertPresentation from '../assets/generated-icons/expert-presentation.png';
import expertResearch from '../assets/generated-icons/expert-research.png';
import expertSpreadsheet from '../assets/generated-icons/expert-spreadsheet.png';
import statusError from '../assets/generated-icons/status-error.png';
import statusSuccess from '../assets/generated-icons/status-success.png';
import statusSync from '../assets/generated-icons/status-sync.png';
import statusUpdate from '../assets/generated-icons/status-update.png';
import statusWarning from '../assets/generated-icons/status-warning.png';
import styleAntigravity from '../assets/generated-icons/style-antigravity.png';
import styleAugment from '../assets/generated-icons/style-augment.png';
import styleClaudeCode from '../assets/generated-icons/style-claude-code.png';
import styleCodex from '../assets/generated-icons/style-codex.png';
import styleCursor from '../assets/generated-icons/style-cursor.png';
import styleDefault from '../assets/generated-icons/style-default.png';
import styleWindsurf from '../assets/generated-icons/style-windsurf.png';

const GENERATED_ICON_URLS = {
  'agent-ceo': agentCeo,
  'agent-meeting-initiator': agentMeetingInitiator,
  'agent-meeting-followup': agentMeetingFollowup,
  'agent-ceo-strategy': agentCeoStrategy,
  'agent-ceo-operating-review': agentCeoOperatingReview,
  'agent-ceo-decision-brief': agentCeoDecisionBrief,
  'agent-ceo-executive-meeting': agentCeoExecutiveMeeting,
  'agent-product-requirements': agentProductRequirements,
  'agent-product-delivery': agentProductDelivery,
  'agent-technical-review': agentTechnicalReview,
  'agent-product-data': agentProductData,
  'agent-marketing-research': agentMarketingResearch,
  'agent-marketing-content': agentMarketingContent,
  'agent-marketing-campaign': agentMarketingCampaign,
  'agent-marketing-performance': agentMarketingPerformance,
  'agent-sales-lead-research': agentSalesLeadResearch,
  'agent-sales-solution': agentSalesSolution,
  'agent-sales-meeting-followup': agentSalesMeetingFollowup,
  'agent-customer-success': agentCustomerSuccess,
  'agent-finance-budget': agentFinanceBudget,
  'agent-finance-analysis': agentFinanceAnalysis,
  'agent-finance-reimbursement': agentFinanceReimbursement,
  'agent-finance-report': agentFinanceReport,
  'agent-hr-recruiting': agentHrRecruiting,
  'agent-hr-onboarding': agentHrOnboarding,
  'agent-hr-performance': agentHrPerformance,
  'agent-admin-coordination': agentAdminCoordination,
  'expert-presentation': expertPresentation,
  'expert-meeting': expertMeeting,
  'expert-document': expertDocument,
  'expert-spreadsheet': expertSpreadsheet,
  'expert-pdf': expertPdf,
  'expert-dataviz': expertDataviz,
  'expert-research': expertResearch,
  'expert-copywriting': expertCopywriting,
  'style-default': styleDefault,
  'style-codex': styleCodex,
  'style-cursor': styleCursor,
  'style-augment': styleAugment,
  'style-claude-code': styleClaudeCode,
  'style-antigravity': styleAntigravity,
  'style-windsurf': styleWindsurf,
  'status-success': statusSuccess,
  'status-warning': statusWarning,
  'status-sync': statusSync,
  'status-error': statusError,
  'status-update': statusUpdate,
} as const;

export type GeneratedIconName = keyof typeof GENERATED_ICON_URLS;

export const GENERATED_ICON_NAMES = Object.freeze(
  Object.keys(GENERATED_ICON_URLS) as GeneratedIconName[],
);

interface GeneratedIconProps {
  name: GeneratedIconName;
  size?: number;
  className?: string;
  alt?: string;
}

/**
 * Codex 内置 imagegen 生成的 Otto 刺绣图标。
 * 默认纯装饰；只有显式传入 alt 时才进入无障碍树。
 */
export function GeneratedIcon({
  name,
  size = 20,
  className,
  alt = '',
}: GeneratedIconProps): React.JSX.Element {
  return (
    <img
      src={GENERATED_ICON_URLS[name]}
      width={size}
      height={size}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      className={['otto-generated-icon', className].filter(Boolean).join(' ')}
      draggable={false}
      decoding="async"
    />
  );
}
