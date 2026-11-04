// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import { getActiveServicesConfig } from '@dotli/config';
import { loadPolkadotApi } from '../lazy.js';
import { getHostChainProvider } from './hostCallbacks/getHostChainProvider.js';
import type { PolkadotAccount } from './polkadotAccount.js';

export type PeopleUsernames = {
  /** The full username, null when the account has only a lite one. */
  full: string | null;
  lite: string;
};

type ConsumerEntry = { lite_username: Uint8Array; full_username?: unknown };

/**
 * Reads the usernames People holds for an account, null when it has none. Rejects when People is not reachable on this
 * backend or its entry is malformed.
 */
export async function readPeopleUsernames(account: PolkadotAccount): Promise<PeopleUsernames | null> {
  const provider = getHostChainProvider(getActiveServicesConfig().people.genesis);
  if (provider === null) {
    throw new Error('People is not reachable on this chain backend');
  }
  const polkadotApi = await loadPolkadotApi();
  const client = polkadotApi.createClient(provider);
  try {
    const consumers = client.getUnsafeApi().query['Resources']?.['Consumers'];
    if (consumers === undefined) {
      throw new Error('People has no Resources.Consumers storage');
    }
    const consumer: unknown = await consumers.getValue(account);
    if (consumer === undefined) {
      return null;
    }
    if (!isConsumerEntry(consumer)) {
      throw new Error(`Resources.Consumers entry for ${account} has no lite_username`);
    }
    return {
      full: consumer.full_username instanceof Uint8Array ? polkadotApi.Binary.toText(consumer.full_username) : null,
      lite: polkadotApi.Binary.toText(consumer.lite_username),
    };
  } finally {
    client.destroy();
  }
}

function isConsumerEntry(value: unknown): value is ConsumerEntry {
  return (
    typeof value === 'object' && value !== null && 'lite_username' in value && value.lite_username instanceof Uint8Array
  );
}
