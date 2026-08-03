/** Financial computation is fail-closed: models may explain verified results, never invent them. */
import { createHash } from 'node:crypto';
import type { PartListUnion } from '@google/genai';

export type ComputationPolicy = 'standard' | 'financial-no-error';

export interface FinancialComputationEvidence {
  toolId: string;
  toolVersion: string;
  operation: string;
  inputHash: string;
  resultHash: string;
  executedAt: string;
}

export interface FinancialConversationState {
  computationPolicy: ComputationPolicy;
  requiresToolComputation: boolean;
  requiresVerifiedEvidence: boolean;
  sourceInputHash?: string;
  evidence?: FinancialComputationEvidence;
}

const FINANCIAL_TERMS = /(?:\b(?:price|pricing|quote|discount|commission|cost|revenue|sales|turnover|profit|loss|cash\s*flow|balance|budget|invoice|salary|payroll|tax(?:es)?|exchange\s*rate|interest|gmv|arr|roi|cac|ltv|gross\s*margin|accounts?\s*(?:payable|receivable)|reconcile|payment)\b|金额|价格|报价|折扣|佣金|成本|收入|营收|销售额|销售|利润|亏损|现金流|余额|预算|发票|工资|薪资|税费|汇率|利率|毛利率|对账|付款|应收|应付|股权|份额)/i;
const COMPUTATION_TERMS = /(?:\b(?:sum|total|average|median|count|dedup(?:licate)?|group|sort|filter|pivot|rank|percent(?:age)?|compare|difference|calculate|compute|forecast|statistics?|spreadsheet|table|csv|xlsx|xls|ods|parquet|json)\b|求和|合计|汇总|平均|中位数|计数|去重|分组|排序|筛选|透视|排名|百分比|同比|环比|差异|计算|统计|预测|表格|数据|对比)/i;

/** A direct financial input is protected even if the user never says “calculate”. */
export function classifyFinancialInput(input: string): FinancialConversationState {
  const financial = FINANCIAL_TERMS.test(input);
  const computational = COMPUTATION_TERMS.test(input);
  if (financial || (computational && /[￥¥$€£]|\b(?:cny|rmb|usd|eur|hkd)\b/i.test(input))) {
    return {
      computationPolicy: 'financial-no-error',
      requiresToolComputation: true,
      requiresVerifiedEvidence: true,
      sourceInputHash: createHash('sha256').update(input).digest('hex'),
    };
  }
  return { computationPolicy: 'standard', requiresToolComputation: false, requiresVerifiedEvidence: false };
}

export function isTrustedFinancialComputationTool(toolName: string): boolean {
  // Adding an allow-listed tool is a security review, not a prompt change.
  return toolName === 'analyze_data';
}

function responseOutput(part: unknown): string {
  if (!part || typeof part !== 'object') return '';
  const response = (part as { functionResponse?: { response?: unknown } }).functionResponse?.response;
  if (!response) return '';
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && 'output' in response) {
    const output = (response as { output?: unknown }).output;
    return typeof output === 'string' ? output : JSON.stringify(output);
  }
  return JSON.stringify(response);
}

/** A call is not evidence: only an allow-listed tool's confirmed success is. */
export function captureFinancialComputationEvidence(request: PartListUnion, sourceInput: string): FinancialComputationEvidence | undefined {
  const parts = Array.isArray(request) ? request : [request];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const response = (part as { functionResponse?: { name?: unknown } }).functionResponse;
    const toolName = typeof response?.name === 'string' ? response.name : '';
    if (!isTrustedFinancialComputationTool(toolName)) continue;
    const output = responseOutput(part);
    if (!/^analyze_data OK:/m.test(output) || /analyze_data FAIL:/i.test(output)) continue;
    return {
      toolId: toolName,
      toolVersion: 'core-analyze-data-v1',
      operation: 'verified-data-analysis',
      inputHash: /^[a-f0-9]{64}$/i.test(sourceInput)
        ? sourceInput
        : createHash('sha256').update(sourceInput).digest('hex'),
      resultHash: createHash('sha256').update(output).digest('hex'),
      executedAt: new Date().toISOString(),
    };
  }
  return undefined;
}

export function containsNumericClaim(text: string): boolean {
  return /(?:[￥¥$€£]\s*\d|\d+(?:[,.]\d+)?\s*(?:%|元|块|万元|亿元|美元|人民币|USD|CNY|RMB|EUR|HKD)|\b\d+(?:[,.]\d+)?\b)/i.test(text);
}

export function shouldBlockFinancialOutput(state: FinancialConversationState | undefined, text: string): boolean {
  return Boolean(state?.computationPolicy === 'financial-no-error' && !state.evidence && containsNumericClaim(text));
}

export const FINANCIAL_COMPUTATION_BLOCK_MESSAGE =
  '财务数据尚未通过不可失误计算工具验证；我不能输出金额、比例、排名或财务结论。请先完成受控工具计算并提供可审计结果。';
