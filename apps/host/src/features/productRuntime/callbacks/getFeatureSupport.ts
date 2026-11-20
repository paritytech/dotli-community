// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Features } from '@parity/truapi-host';
import { isRemoteChainSupported } from '@dotli/protocol';

/** Answers whether the host serves the chain or draws the materials a product asks about. Never rejects. */
export function getFeatureSupport(
  request: Parameters<Features['featureSupported']>[0],
): ReturnType<Features['featureSupported']> {
  switch (request.tag) {
    // The curated gateway set under `rpc-gateway`, otherwise every chain the light client runs.
    case 'Chain':
      return Promise.resolve({ supported: isRemoteChainSupported(request.value.genesisHash) });
    // The chat draws a `Materials` node's children without its layers.
    case 'Materials':
      return Promise.resolve({ supported: false });
  }
}
