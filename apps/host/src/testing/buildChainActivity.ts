// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChainActivity } from '@dotli/chains';

type Params = Partial<ChainActivity> & {
  /** The chain the activity is about. */
  genesisHash: string;
  /** False for a chain nobody holds and nothing follows. Defaults to true: one consumer holds it, following. */
  held?: boolean;
};

/** Returns a connected chain's activity, held or released as `held` says, with any other given field on top. Never throws. */
export function buildChainActivity({ genesisHash, held = true, ...overrides }: Params): ChainActivity {
  return { genesisHash, consumers: held ? 1 : 0, status: 'connected', following: held, ...overrides };
}
