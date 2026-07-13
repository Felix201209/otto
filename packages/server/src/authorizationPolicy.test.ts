import { describe, expect, it } from 'vitest';
import {
  isMandatoryConfirmation,
  shouldRequestConfirmation,
} from './authorizationPolicy.js';

describe('授权策略', () => {
  it('手动授权会确认所有需要确认的操作', () => {
    expect(shouldRequestConfirmation('manual', { type: 'edit' })).toBe(true);
  });

  it('自动授权跳过普通操作，但不跳过高危、删除、危险命令与用户问答', () => {
    expect(shouldRequestConfirmation('auto', { type: 'edit' })).toBe(false);
    expect(shouldRequestConfirmation('auto', { type: 'exec', riskLevel: 'high' })).toBe(true);
    expect(shouldRequestConfirmation('auto', { type: 'exec', warning: '危险' })).toBe(true);
    expect(shouldRequestConfirmation('auto', { type: 'delete' })).toBe(true);
    expect(shouldRequestConfirmation('auto', { type: 'question' })).toBe(true);
  });

  it('无确认详情时无需弹窗', () => {
    expect(shouldRequestConfirmation('manual', false)).toBe(false);
    expect(isMandatoryConfirmation(false)).toBe(false);
  });
});
