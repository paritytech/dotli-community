// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The sandbox rebuilds these by name across postMessage, so callers branch on `error.name`, not `instanceof`.

export const BITSWAP_ERRORS = {
  /** The protocol frame does not serve the Bulletin chain. */
  UNAVAILABLE: 'BitswapUnavailableError',
  /** The light client answered with an error the client does not retry. */
  RPC: 'BitswapRpcError',
  /** The connection to the protocol frame died under the request. */
  CONNECTION: 'BitswapConnectionError',
  /** No peer produced the block within the discovery allowance. */
  NOT_FOUND: 'BitswapNotFoundError',
  TIMEOUT: 'BitswapTimeoutError',
} as const;

/** `err` with its `name` set, so it reaches Sentry as its own exception type. */
export function named<E extends Error>(err: E, name: string): E {
  err.name = name;
  return err;
}
