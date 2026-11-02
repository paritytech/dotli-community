// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainPool, ChainPoolWatcher } from '@dotli/chains';
import { hostChainPool } from './createHostChainPool.js';

type Params = {
  /** The pool watched. The page's host chain pool by default. */
  pool?: ChainPool;
};

/**
 * Reports who holds each host chain and its best blocks. The watcher never leases a chain, so it never opens or keeps
 * one. It follows only those someone holds. Returns the unwatch.
 */
export function watchHostChains(watcher: ChainPoolWatcher, { pool = hostChainPool }: Params = {}): () => void {
  return pool.watch(watcher);
}
