// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept out of index.ts, which must stay pure re-exports for rolldown to drop unused ones from a chunk.

import type * as ResolveNamespace from './createDotnsResolver.js';

export type ResolveModule = typeof ResolveNamespace;

/** Loads the resolve module in its own chunk. Rejects when the chunk fails to load. */
export function loadResolve(): Promise<ResolveModule> {
  return import('./createDotnsResolver.js');
}
