import type { HostCallbacks } from "@parity/truapi-host-wasm";
import { getBackend } from "@dotli/config/mode";
import { isChainSupported as isSmoldotChainSupported } from "@dotli/resolver/chains";
import { isRpcChainSupported } from "@dotli/resolver/rpc-chain";

export function createFeatureSupported(): HostCallbacks["featureSupported"] {
  return (request) => {
    const supported =
      getBackend() === "rpc-gateway"
        ? isRpcChainSupported(request.value.genesisHash)
        : isSmoldotChainSupported(request.value.genesisHash);
    return Promise.resolve({ supported });
  };
}
