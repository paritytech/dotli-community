// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Visitor copy for a trusted-provider HTTPS endpoint that refused the connection outright (`Failed to fetch`, not a
 * timeout), one sentence wherever the visitor meets it. Names the host because a visitor can check a hostname, not "the
 * trusted provider".
 */
export function describeGatewayUnreachable(host: string | undefined): string {
  return host === undefined || host === ''
    ? "Your browser couldn't connect to the trusted provider."
    : `Your browser couldn't connect to the trusted provider ${host}.`;
}
