// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// Lazy entry points, each its own chunk, so the page boot leaves them out.

import type * as HostChainProviderNamespace from './getHostChainProvider.js';

/**
 * The host chain pool's providers, for a page that must not carry the pool at boot. Rejects when its chunk fails to
 * load.
 */
export function loadHostChainProviders(): Promise<typeof HostChainProviderNamespace> {
  return import('./getHostChainProvider.js');
}
