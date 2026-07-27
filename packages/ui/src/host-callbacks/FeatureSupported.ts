import type { Features } from "@parity/truapi-host";
import { getBackend } from "@dotli/config/mode";
import { isChainSupported as isSmoldotChainSupported } from "@dotli/resolver/provider";
import { isRpcChainSupported } from "@dotli/resolver/rpc-chain";

export function createFeatureSupported(): Features["featureSupported"] {
  return (request) => {
    const supported =
      getBackend() === "rpc-gateway"
        ? isRpcChainSupported(request.value.genesisHash)
        : isSmoldotChainSupported(request.value.genesisHash);
    return Promise.resolve({ supported });
  };
}
