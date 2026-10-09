// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Callers branch on `error.name`, not `instanceof`, because bitswap errors are rebuilt across postMessage.
// Kept apart from the throwing modules so importing a name pulls in no hashing code.

export const CONTENT_ERRORS = {
  /** Fetched bytes are not the content the CID names, or cannot be checked. */
  VERIFICATION: 'ContentVerificationError',
  BITSWAP_UNAVAILABLE: 'BitswapUnavailableError',
  /** The light client answered with an error the retry loop does not retry. */
  BITSWAP_RPC: 'BitswapRpcError',
  /** The connection to the protocol frame died under the request. */
  BITSWAP_CONNECTION: 'BitswapConnectionError',
  /** No peer produced the block within the discovery allowance. */
  BITSWAP_NOT_FOUND: 'BitswapNotFoundError',
  BITSWAP_TIMEOUT: 'BitswapTimeoutError',
} as const;

/** `err` with its `name` set, so it reaches Sentry as its own exception type. */
export function named<E extends Error>(err: E, name: string): E {
  err.name = name;
  return err;
}
