// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The page's one client, so every block fetch on the page shares its Bulletin connection and its same-CID wait.

import { getActiveServicesConfig } from '@dotli/config';
import { protocolClient } from '@dotli/protocol';

import { createBitswapClient, type BitswapClient } from './client.js';

let pageClient: BitswapClient | null = null;

/** Fetches one block over the page's protocol frame. See `BitswapClient.get`. */
export function bitswapGet(cid: string, signal?: AbortSignal): Promise<Uint8Array> {
  pageClient ??= createBitswapClient({
    provider: () => protocolClient().createRemoteChainProvider(getActiveServicesConfig().bulletin.genesis),
  });
  return pageClient.get(cid, signal);
}
