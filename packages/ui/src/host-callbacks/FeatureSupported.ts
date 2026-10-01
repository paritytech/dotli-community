import type { Features } from '@parity/truapi-host';
import { getBackend } from '@dotli/config';
import { isRemoteChainSupported } from '@dotli/protocol';
import { isRpcChainSupported } from '@dotli/resolver';

export function createFeatureSupported(): Features['featureSupported'] {
  return request => {
    const supported =
      getBackend() === 'rpc-gateway'
        ? isRpcChainSupported(request.value.genesisHash)
        : isRemoteChainSupported(request.value.genesisHash);
    return Promise.resolve({ supported });
  };
}
