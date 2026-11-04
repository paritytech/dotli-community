// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveServicesConfig } from '@dotli/config';
import type { H160Address } from '../h160Address.js';
import { loadPolkadotApi } from '../lazy.js';
import { getHostChainProvider } from './hostCallbacks/getHostChainProvider.js';
import { parsePolkadotAccount, type PolkadotAccount } from './polkadotAccount.js';

/**
 * Reads the Polkadot account an Asset Hub contract address was mapped from, null when it was not mapped. Rejects when
 * Asset Hub is not reachable on this backend or the read fails.
 */
export async function readOriginalAccount(address: H160Address): Promise<PolkadotAccount | null> {
  const provider = getHostChainProvider(getActiveServicesConfig().assethub.genesis);
  if (provider === null) {
    throw new Error('Asset Hub is not reachable on this chain backend');
  }
  const polkadotApi = await loadPolkadotApi();
  const client = polkadotApi.createClient(provider);
  try {
    const originalAccount = client.getUnsafeApi().query['Revive']?.['OriginalAccount'];
    if (originalAccount === undefined) {
      throw new Error('Asset Hub has no Revive.OriginalAccount storage');
    }
    const account: unknown = await originalAccount.getValue(address);
    if (account === undefined) {
      return null;
    }
    if (typeof account !== 'string') {
      throw new Error(`Revive.OriginalAccount for ${address} is not an account`);
    }
    return parsePolkadotAccount(account);
  } finally {
    client.destroy();
  }
}
