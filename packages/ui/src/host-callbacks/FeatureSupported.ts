import type { Features } from "@parity/truapi-host";
import { getBackend } from "@dotli/config/mode";
import {
  getActiveGatewaySupportedGenesisHashes,
  getActiveSupportedGenesisHashes,
} from "@dotli/config/network";

export function createFeatureSupported(): Features["featureSupported"] {
  return (request) => {
    const supportedHashes =
      getBackend() === "rpc-gateway"
        ? getActiveGatewaySupportedGenesisHashes()
        : getActiveSupportedGenesisHashes();
    return Promise.resolve({
      supported: supportedHashes.has(request.value.genesisHash.toLowerCase()),
    });
  };
}
