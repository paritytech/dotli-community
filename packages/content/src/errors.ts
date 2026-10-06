// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Names of the errors this package throws.
//
// Callers branch on `error.name`, not `instanceof`: bitswap errors are rebuilt
// on the far side of a postMessage, and a caller classifying a fetch failure
// must not import the verifier's hashing code just to name it. Kept apart from
// the modules that throw them so importing a name costs nothing.

export const CONTENT_ERRORS = {
  /** Fetched bytes are not the content the CID names, or cannot be checked. */
  VERIFICATION: 'ContentVerificationError',
  /** The Bulletin chain is not reachable from this host at all. */
  BITSWAP_UNAVAILABLE: 'BitswapUnavailableError',
  /** The light client answered with an error the retry loop does not retry. */
  BITSWAP_RPC: 'BitswapRpcError',
  /** The connection to the protocol frame died under the request. */
  BITSWAP_CONNECTION: 'BitswapConnectionError',
  /** No peer produced the block within the discovery allowance. */
  BITSWAP_NOT_FOUND: 'BitswapNotFoundError',
  /** The whole retry budget ran out. */
  BITSWAP_TIMEOUT: 'BitswapTimeoutError',
} as const;

/** `err` with its `name` set, so it reaches Sentry as its own exception type. */
export function named<E extends Error>(err: E, name: string): E {
  err.name = name;
  return err;
}
