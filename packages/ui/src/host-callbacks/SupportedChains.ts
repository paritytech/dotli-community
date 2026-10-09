// Filtered through the same predicate as `featureSupported`, so the two never disagree. In
// RPC-gateway mode Bulletin is absent on purpose because IPFS gateways serve its content.

import type { Features } from '@parity/truapi-host';
import type { ChainIdentifier } from '@parity/truapi';
import { toHexString } from '@parity/truapi/scale';
import { getActiveServicesConfig, getNetwork } from '@dotli/config';

import { isRemoteChainSupported } from '@dotli/protocol';

export function createSupportedChains(): Features['supportedChains'] {
  return () => {
    const cfg = getActiveServicesConfig();
    const slots: { identifier: ChainIdentifier; genesis: string }[] = [
      { identifier: 'Relay', genesis: cfg.relay.genesis },
      { identifier: 'AssetHub', genesis: cfg.assethub.genesis },
      { identifier: 'People', genesis: cfg.people.genesis },
      { identifier: 'Bulletin', genesis: cfg.bulletin.genesis },
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
  };
}
