// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Imports nothing, so a caller on an eager path can take this module without the rest of the package.

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
