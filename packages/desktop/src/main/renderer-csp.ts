/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */

/** Renderer CSP 的纯函数构造器，便于单测确认只放行 HTTPS 头像资源。 */
export function buildRendererCsp(
  host: string,
  portOrPorts: number | readonly number[],
): string {
  const ports = [
    ...new Set(
      (Array.isArray(portOrPorts) ? portOrPorts : [portOrPorts]).filter(
        (port) => Number.isInteger(port) && port > 0 && port <= 65535,
      ),
    ),
  ];
  const connectSources = ports.flatMap((port) => [
    `http://${host}:${port}`,
    `ws://${host}:${port}`,
  ]);
  return [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${connectSources.join(' ')}`,
    "script-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-src 'none'",
  ].join('; ');
}
