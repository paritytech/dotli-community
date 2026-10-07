// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// No imports, so the host's eager protocol client takes these without pulling the broker into its chunk.

/**
 * The `error.data` of an answer to a request the chain halted under. The chain
 * is rebuilt on the next connect, so a client that sees it may retry there.
 */
export const CHAIN_HALTED_ERROR_DATA = 'dotli:chain-halted';

/** The JSON-RPC error a request gets when its chain halted under it, or none can be had after a halt. */
export function chainHaltedError(): { code: number; message: string; data: string } {
  return { code: -32603, message: 'Chain transport halted', data: CHAIN_HALTED_ERROR_DATA };
}

/** Why a remote connection halted: its own chain died, or the whole frame did. */
export type RemoteChainHalt = 'chain' | 'frame';

/** A chain transport's halt that says why, so a pool's leases can tell their consumers. */
export class ChainHaltError extends Error {
  readonly reason: RemoteChainHalt;

  constructor(reason: RemoteChainHalt) {
    super(`Chain halted (${reason})`);
    this.name = 'ChainHaltError';
    this.reason = reason;
  }
}

/**
 * Why a halt happened. Anything but a `ChainHaltError` is the chain's own halt. Matched by name to read errors from
 * another realm.
 */
export function haltReasonOf(error: unknown): RemoteChainHalt {
  const isHaltError = error instanceof Error && error.name === 'ChainHaltError';
  return isHaltError && (error as Partial<ChainHaltError>).reason === 'frame' ? 'frame' : 'chain';
}
