// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Returns the hostname a request names, without its port, or `''` when it names none. HTTP/2, which the https dev
 * servers speak, carries it as `:authority`, not `Host`. Never throws.
 */
export function getRequestHostname(headers: Readonly<Record<string, string | string[] | undefined>>): string {
  const authority = headers['host'] ?? headers[':authority'];
  return (typeof authority === 'string' ? authority : '').split(':')[0] ?? '';
}
