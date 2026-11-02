// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Kept out of index.ts, which must stay pure re-exports for rolldown to drop unused ones from a chunk.

import type * as ProviderNamespace from './createLightClient.js';

export type ProviderModule = typeof ProviderNamespace;

/** Loads the light client's module in its own chunk, so it stays off the boot path until called. */
export function loadProvider(): Promise<ProviderModule> {
  return import('./createLightClient.js');
}
