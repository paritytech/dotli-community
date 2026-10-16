// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Error copy that both the host and the sandbox can show, so a visitor reads the same sentence from either.

/**
 * A trusted-provider HTTPS endpoint refused the connection outright (`Failed to fetch`, not a timeout).
 * Names the host because a visitor can check a hostname, not "the trusted provider".
 */
export function gatewayUnreachable(host: string | undefined): string {
  return host === undefined || host === ''
    ? "Your browser couldn't connect to the trusted provider."
    : `Your browser couldn't connect to the trusted provider ${host}.`;
}

/** Hostname of a `wss://` or `https://` endpoint, for use in visitor-facing copy. */
export function endpointHost(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined || endpoint === '') {
    return undefined;
  }
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}
