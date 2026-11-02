// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

/** Hostname of a `wss://` or `https://` endpoint, for use in visitor-facing copy. */
export function getEndpointHost(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined || endpoint === '') {
    return undefined;
  }
  try {
    return new URL(endpoint).hostname;
  } catch {
    return endpoint;
  }
}
