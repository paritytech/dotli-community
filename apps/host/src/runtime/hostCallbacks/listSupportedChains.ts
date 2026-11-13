// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Features } from '@parity/truapi-host';
import type { ChainIdentifier } from '@parity/truapi';
import { toHexString } from '@parity/truapi/scale';
import { getActiveServicesConfig, getNetwork } from '@dotli/config';
import { isRemoteChainSupported } from '@dotli/protocol';

/** Lists the network's chains that the backend in force serves, read on each call. Never rejects. */
export function listSupportedChains(): ReturnType<Features['supportedChains']> {
  const config = getActiveServicesConfig();
  const slots: { identifier: ChainIdentifier; genesis: string }[] = [
    { identifier: 'Relay', genesis: config.relay.genesis },
    { identifier: 'AssetHub', genesis: config.assethub.genesis },
    { identifier: 'People', genesis: config.people.genesis },
    { identifier: 'Bulletin', genesis: config.bulletin.genesis },
  ];
  return Promise.resolve({
    network: getNetwork(),
    chains: slots
      .filter(({ genesis }) => isRemoteChainSupported(genesis))
      .map(({ identifier, genesis }) => ({
        identifier,
        genesisHash: toHexString(genesis),
      })),
  });
}
