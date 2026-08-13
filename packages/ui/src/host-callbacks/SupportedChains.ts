// TrUAPI supported-chains callback.
//
// Maps the protocol's closed chain-role enum onto the active environment's
// config slots. The core answers `chain.getChainInfo` from this one set,
// resolving a requested identifier and mapping a miss to `NotSupported`.
//
// The set is filtered through the same per-backend predicate as
// `featureSupported`, so the two advertisements can never disagree. In
// RPC-gateway mode Bulletin is intentionally absent because its content is
// served via IPFS gateways. The core-owned Bulletin connection seam in
// `Chain.ts` is not a product-facing advertisement.

import type { Features } from "@parity/truapi-host";
import type { ChainIdentifier } from "@parity/truapi";
import { toHexString } from "@parity/truapi/scale";
import { getBackend } from "@dotli/config/mode";
import { getActiveServicesConfig, getNetwork } from "@dotli/config/network";
import { isChainSupported as isSmoldotChainSupported } from "@dotli/resolver/chains";
import { isRpcChainSupported } from "@dotli/resolver/rpc-chain";

export function createSupportedChains(): Features["supportedChains"] {
  return () => {
    const cfg = getActiveServicesConfig();
    const slots: { identifier: ChainIdentifier; genesis: string }[] = [
      { identifier: "Relay", genesis: cfg.relay.genesis },
      { identifier: "AssetHub", genesis: cfg.assethub.genesis },
      { identifier: "People", genesis: cfg.people.genesis },
      { identifier: "Bulletin", genesis: cfg.bulletin.genesis },
    ];
    const isSupported =
      getBackend() === "rpc-gateway"
        ? isRpcChainSupported
        : isSmoldotChainSupported;
    // The environment id ("paseo-next-v2"), not a bare ecosystem ("paseo"):
    // the field is informational and two environments of one ecosystem must
    // stay distinguishable in product logs.
    return Promise.resolve({
      network: getNetwork(),
      chains: slots
        .filter(({ genesis }) => isSupported(genesis))
        .map(({ identifier, genesis }) => ({
          identifier,
          genesisHash: toHexString(genesis),
        })),
    });
  };
}
