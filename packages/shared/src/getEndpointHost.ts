// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Hostname of a `wss://` or `https://` endpoint, for use in visitor-facing copy. */
export function getEndpointHost(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined || endpoint === '') {
    return undefined;
  }
  try {
    // A value without a scheme, such as `localhost:9944`, parses with `localhost:` as the scheme and an empty host.
    return new URL(endpoint).hostname || endpoint;
  } catch {
    return endpoint;
  }
}
