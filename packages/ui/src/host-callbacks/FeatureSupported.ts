import type { Features } from '@parity/truapi-host';
import { isRemoteChainSupported } from '@dotli/protocol';

export function createFeatureSupported(): Features['featureSupported'] {
  // The curated gateway set under `rpc-gateway`, otherwise every chain the light client runs.
  return request => Promise.resolve({ supported: isRemoteChainSupported(request.value.genesisHash) });
}
