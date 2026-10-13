// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The lite username the network holds for the local wallet's identity account, read until the network answers once
// per page and cached in the shared wallet record so the next boot activates with it.

import { getActiveServicesConfig, SITE_ID } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { updateSharedLocalWalletIdentity, type LocalWalletIdentity } from '@dotli/protocol';
import { createAsyncTaskPool, log } from '@dotli/shared';
import { hexToBytes } from '@parity/truapi/scale';
import { loadBridge } from '../lazy.js';
import { reportLocalWalletFailure, type LocalWalletBoot, type LocalWalletFailureReason } from './wallet-boot.js';

export interface LiteUsernameRefreshDeps {
  /** The name People holds for the account, null when it has none. */
  readLiteUsername: (identityAccountId: string) => Promise<string | null>;
  /** Caches the identity in the shared wallet record for the next boot. */
  saveIdentity: (identity: LocalWalletIdentity) => Promise<void>;
  reportFailure: (error: unknown, reason: LocalWalletFailureReason) => void;
}

export interface LiteUsernameRefresh {
  /**
   * Undefined when there is nothing to re-activate, otherwise the new name, null when the account has none.
   * `identityAccountId` is the account the calling core reported for its session.
   */
  refresh(wallet: LocalWalletBoot, identityAccountId: Promise<string>): Promise<string | null | undefined>;
}

export function createLiteUsernameRefresh(deps: LiteUsernameRefreshDeps): LiteUsernameRefresh {
  // One read at a time, so every core on the page takes the first read's answer.
  const reads = createAsyncTaskPool({ poolSize: 1 });
  // Null until the network answers. A failed read tells nothing, so the next core reads again.
  let answer: { name: string | null | undefined } | null = null;

  const readChange = async (
    wallet: LocalWalletBoot,
    identityAccountId: string,
  ): Promise<{ name: string | null | undefined } | null> => {
    let name: string | null;
    try {
      name = await deps.readLiteUsername(identityAccountId);
    } catch (error) {
      log.warn('[dot.li wallet] lite username read failed, keeping the cached name:', error);
      m.count(S.WALLET_LOCAL_ACTIVATE, { outcome: 'error', reason: 'username-read' });
      return null;
    }
    const cached = wallet.identity;
    if (cached?.identityAccountId === identityAccountId && cached.liteUsername === name) {
      return { name: undefined };
    }
    try {
      await deps.saveIdentity({ identityAccountId, liteUsername: name });
    } catch (error) {
      // Reported here, once for every core sharing this read. The name still holds for this page, and the next boot
      // reads it again.
      deps.reportFailure(error, 'identity-save');
    }
    const activatedWith = cached?.liteUsername ?? null;
    return { name: name === activatedWith ? undefined : name };
  };

  return {
    async refresh(wallet, identityAccountId) {
      // Awaited outside the queue, so a core that goes down before reporting never holds up another core's read.
      const account = await identityAccountId;
      return reads.call(async () => {
        answer ??= await readChange(wallet, account);
        return answer?.name;
      });
    },
  };
}

function isConsumer(value: unknown): value is { lite_username: Uint8Array } {
  return (
    typeof value === 'object' && value !== null && 'lite_username' in value && value.lite_username instanceof Uint8Array
  );
}

async function readFromPeople(identityAccountId: string): Promise<string | null> {
  const { hostChainProvider } = await loadBridge();
  const provider = hostChainProvider(getActiveServicesConfig().people.genesis);
  if (provider === null) {
    throw new Error('People is not reachable on this chain backend');
  }
  const papi = await import('polkadot-api');
  const client = papi.createClient(provider);
  try {
    const account = papi.AccountId().dec(hexToBytes(identityAccountId));
    const consumers = client.getUnsafeApi().query['Resources']?.['Consumers'];
    if (consumers === undefined) {
      throw new Error('People has no Resources.Consumers storage');
    }
    const consumer: unknown = await consumers.getValue(account);
    if (consumer === undefined) {
      return null;
    }
    if (!isConsumer(consumer)) {
      throw new Error('Resources.Consumers entry has no lite_username');
    }
    return papi.Binary.toText(consumer.lite_username);
  } finally {
    client.destroy();
  }
}

/** The page's refresh, shared by its local wallet cores. */
const liteUsernameRefresh: LiteUsernameRefresh = createLiteUsernameRefresh({
  readLiteUsername: readFromPeople,
  saveIdentity: identity => updateSharedLocalWalletIdentity(SITE_ID, identity),
  reportFailure: reportLocalWalletFailure,
});

export function refreshLiteUsername(
  wallet: LocalWalletBoot,
  identityAccountId: Promise<string>,
): Promise<string | null | undefined> {
  return liteUsernameRefresh.refresh(wallet, identityAccountId);
}
