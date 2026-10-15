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

/** Puts the JSON-RPC error code on `err`, where the retry logic reads it. */
export function withCode<E extends Error>(err: E, code: number): E {
  (err as { code?: number }).code = code;
  return err;
}

/** The JSON-RPC error code an error carries, or null. */
export function errorCode(err: unknown): number | null {
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'number' ? code : null;
}
