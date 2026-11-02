// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveServicesConfig } from '@dotli/config';

/** The active network's first IPFS gateway. Throws when the network configures none. */
export function getDefaultGateway(): string {
  const [gateway] = getActiveServicesConfig().bulletin.ipfsGateways;
  if (gateway === undefined) {
    throw new Error('No IPFS gateway configured for the active network.');
  }
  return gateway;
}
