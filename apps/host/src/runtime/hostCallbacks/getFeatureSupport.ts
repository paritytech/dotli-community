// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { Features } from '@parity/truapi-host';
import { isRemoteChainSupported } from '@dotli/protocol';

/** Answers whether the backend in force serves the chain a product asks about. Never rejects. */
export function getFeatureSupport(
  request: Parameters<Features['featureSupported']>[0],
): ReturnType<Features['featureSupported']> {
  // The curated gateway set under `rpc-gateway`, otherwise every chain the light client runs.
  return Promise.resolve({ supported: isRemoteChainSupported(request.value.genesisHash) });
}
