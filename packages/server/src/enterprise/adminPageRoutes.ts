/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

import type { ServerResponse } from 'node:http';

export interface AdminPageRenderers {
  adminAccountsHTML(): string;
  parkAdminHTML(): string;
  platformAdminHTML(): string;
  adminDashboardHTML(): string;
  adminCreditsHTML(): string;
}

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const PARK_HTML_HEADERS = {
  ...HTML_HEADERS,
  'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function handleAdminPageRoute(
  method: string,
  path: string,
  res: ServerResponse,
  renderers: AdminPageRenderers,
): boolean {
  if (method !== 'GET') return false;

  if (path === '/enterprise/admin') {
    res.writeHead(200, HTML_HEADERS);
    res.end(renderers.adminAccountsHTML());
    return true;
  }

  if (path === '/enterprise/park-admin') {
    res.writeHead(200, PARK_HTML_HEADERS);
    res.end(renderers.parkAdminHTML());
    return true;
  }

  if (path === '/enterprise/admin/platform') {
    res.writeHead(200, HTML_HEADERS);
    res.end(renderers.platformAdminHTML());
    return true;
  }

  if (path === '/enterprise/dashboard') {
    res.writeHead(200, HTML_HEADERS);
    // The dashboard shell contains no server-injected token. Admin sessions are
    // read from same-origin sessionStorage by the page script.
    res.end(renderers.adminDashboardHTML());
    return true;
  }

  if (path === '/enterprise/admin/credits') {
    res.writeHead(200, HTML_HEADERS);
    res.end(renderers.adminCreditsHTML());
    return true;
  }

  return false;
}
