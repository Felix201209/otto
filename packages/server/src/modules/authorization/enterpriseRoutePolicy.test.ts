import { describe, expect, it } from 'vitest';
import { isAdminRoute, isMemberRoute } from './enterpriseRoutePolicy.js';

describe('customer module route authorization', () => {
  it('keeps authoring and installation on member sessions', () => {
    expect(isMemberRoute('/enterprise/customer-modules')).toBe(true);
    expect(isMemberRoute('/enterprise/customer-modules/com.acme.report/1.0.0/install')).toBe(true);
    expect(isAdminRoute('/enterprise/customer-modules/com.acme.report/1.0.0/install')).toBe(false);
  });

  it('reserves public-market review and suspension for platform administration', () => {
    const review = '/enterprise/platform/customer-modules/com.acme.report/1.0.0/review';
    expect(isAdminRoute(review)).toBe(true);
    expect(isMemberRoute(review)).toBe(false);
  });
});
