import { describe, expect, it } from 'vitest';
import { captureFinancialComputationEvidence, classifyFinancialInput, shouldBlockFinancialOutput } from './financialComputationPolicy.js';

describe('financialComputationPolicy', () => {
  it.each([
    '这份 xlsx 的销售额合计是多少？',
    '报价单里有一笔 USD 12,500，请核对折扣。',
    '请对截图里的税费和应收账款做对账。',
  ])('protects direct financial input: %s', (input) => {
    const state = classifyFinancialInput(input);
    expect(state.computationPolicy).toBe('financial-no-error');
    expect(state.requiresToolComputation).toBe(true);
  });

  it('does not classify an ordinary non-financial request', () => {
    expect(classifyFinancialInput('把这段 TypeScript 代码格式化').computationPolicy).toBe('standard');
  });

  it('blocks numeric financial output until trusted tool evidence exists', () => {
    const state = classifyFinancialInput('计算这张表的利润和毛利率');
    expect(shouldBlockFinancialOutput(state, '利润是 1200 元，毛利率 35%。')).toBe(true);
    expect(shouldBlockFinancialOutput(state, '我需要先校验计算口径。')).toBe(false);
  });

  it('accepts only a successful allow-listed calculation result as evidence', () => {
    const success = [{ functionResponse: { name: 'analyze_data', response: { output: 'analyze_data OK: summary\\nrevenue,1200' } } }];
    expect(captureFinancialComputationEvidence(success, '计算销售收入')?.toolId).toBe('analyze_data');
    const failed = [{ functionResponse: { name: 'analyze_data', response: { output: 'analyze_data FAIL: duckdb missing' } } }];
    expect(captureFinancialComputationEvidence(failed, '计算销售收入')).toBeUndefined();
  });

  it('unblocks numeric output only after verified evidence is attached', () => {
    const state = classifyFinancialInput('计算这张表的税费');
    state.evidence = captureFinancialComputationEvidence([
      { functionResponse: { name: 'analyze_data', response: { output: 'analyze_data OK: tax,88' } } },
    ], '计算这张表的税费');
    expect(shouldBlockFinancialOutput(state, '税费为 88 元。')).toBe(false);
  });
});
