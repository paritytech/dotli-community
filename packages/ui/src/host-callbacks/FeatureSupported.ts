import type { Features } from '@parity/truapi-host';
import { isRemoteChainSupported } from '@dotli/protocol';

export function createFeatureSupported(): Features['featureSupported'] {
  // What the active backend advertises: the curated gateway set in
  // `rpc-gateway`, every chain the protocol frame's light client runs otherwise.
  return request => Promise.resolve({ supported: isRemoteChainSupported(request.value.genesisHash) });
}
