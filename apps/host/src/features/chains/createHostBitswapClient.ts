// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { createBitswapClient, type BitswapClient } from '@dotli/bitswap';
import type { ChainPool } from '@dotli/chains';
import { getActiveServicesConfig } from '@dotli/config';
import { hostChainPool } from './createHostChainPool.js';
import { getHostChainProvider } from './getHostChainProvider.js';

type Params = {
  /** The pool Bulletin is leased from. The page's host chain pool by default. */
  pool?: ChainPool;
};

/** Creates a bitswap client that leases Bulletin from `pool` while a fetch runs. */
export function createHostBitswapClient({ pool = hostChainPool }: Params = {}): BitswapClient {
  return createBitswapClient({
    provider: () => getHostChainProvider(getActiveServicesConfig().bulletin.genesis, { pool }),
  });
}

/** The page's one bitswap client. Building it opens nothing. */
export const hostBitswapClient = createHostBitswapClient();
