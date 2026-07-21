import { describe, expect, it } from 'vitest';
import { adminAccountsHTML } from './server.js';

describe('enterprise admin web configuration', () => {
  it('内置真实的功能开关、部门职位与产业园管理入口', () => {
    const html = adminAccountsHTML();
    expect(html).toContain('功能开关');
    expect(html).toContain('部门与职位管理');
    expect(html).toContain('产业园邀请码');
    expect(html).toContain('/enterprise/organization/features');
    expect(html).toContain('/enterprise/organization/departments');
    expect(html).toContain('/enterprise/organization/positions');
    expect(html).toContain('/enterprise/park/services');
    expect(html).toContain('/enterprise/park/specialists');
    expect(html).not.toContain('宏创AI园区服务');
  });

  it('内联脚本保持可解析', () => {
    const html = adminAccountsHTML();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });
});
