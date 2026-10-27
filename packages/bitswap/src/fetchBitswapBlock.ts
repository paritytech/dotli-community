// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one client, so every block fetch on the page shares its Bulletin connection and its same-CID wait.

import { getActiveServicesConfig } from '@dotli/config';
import { getProtocolClient } from '@dotli/protocol';

import { createBitswapClient, type BitswapClient } from './createBitswapClient.js';

let pageClient: BitswapClient | null = null;

/**
 * Fetches one block over the page's protocol frame, on a client built at the first call. Pass `signal` from anything
 * that can be torn down, since a retrying call runs for minutes. Rejects when the block cannot be fetched within the
 * budget, and with an `AbortError` once `signal` fires.
 */
export function fetchBitswapBlock(cid: string, signal?: AbortSignal): Promise<Uint8Array> {
  pageClient ??= createBitswapClient({
    provider: () => getProtocolClient().chains.createProvider(getActiveServicesConfig().bulletin.genesis),
  });
  return pageClient.get(cid, signal);
}
