// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// A leaf of its own, with no imports: the host's eager protocol client needs
// only these, and importing them from the broker would pull the whole broker
// into that chunk.

/**
 * The `error.data` of an answer to a request the chain halted under. The chain
 * is rebuilt on the next connect, so a client that sees it may retry there.
 */
export const CHAIN_HALTED_ERROR_DATA = 'dotli:chain-halted';

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
 * Why the chain behind a halt error halted. Anything but a `ChainHaltError`
 * (a smoldot or socket death) is the chain's own halt. Matched by name as
 * well, for an error from another realm.
 */
export function haltReasonOf(error: unknown): RemoteChainHalt {
  const isHaltError = error instanceof ChainHaltError || (error instanceof Error && error.name === 'ChainHaltError');
  if (!isHaltError) {
    return 'chain';
  }
  return (error as Partial<ChainHaltError>).reason === 'frame' ? 'frame' : 'chain';
}
