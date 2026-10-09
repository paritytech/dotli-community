// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The lite username the network holds for the local wallet's identity account, read once per page and cached in the
// shared wallet record so the next boot activates with it.

import { getActiveServicesConfig, SITE_ID } from '@dotli/config';
import { m, spans as S } from '@dotli/metrics';
import { updateSharedLocalWalletIdentity } from '@dotli/protocol';
import { log } from '@dotli/shared';
import { hexToBytes } from '@parity/truapi/scale';
import { loadBridge } from './lazy.js';
import { authStore, getAuthState } from './state/auth.js';
import { reportLocalWalletFailure, type LocalWalletBoot } from './wallet-boot.js';

type ReadLiteUsername = (identityAccountId: string) => Promise<string | null>;

let refresh: Promise<string | null | undefined> | null = null;

/** The core reports the identity account through the auth state once the session is active. */
function connectedIdentityAccount(): Promise<string> {
  return new Promise(resolve => {
    const settle = (): boolean => {
      const state = getAuthState();
      if (state.tag === 'Connected' && state.session.identityAccountId !== undefined) {
        resolve(state.session.identityAccountId);
        return true;
      }
      return false;
    };
    if (settle()) {
      return;
    }
    const unsubscribe = authStore.subscribe(() => {
      if (settle()) {
        unsubscribe();
      }
    });
  });
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

let readLiteUsername: ReadLiteUsername = readFromPeople;

async function readChange(wallet: LocalWalletBoot): Promise<string | null | undefined> {
  const identityAccountId = await connectedIdentityAccount();
  let name: string | null;
  try {
    name = await readLiteUsername(identityAccountId);
  } catch (error) {
    log.warn('[dot.li wallet] lite username read failed, keeping the cached name:', error);
    m.count(S.WALLET_LOCAL_ACTIVATE, { outcome: 'error', reason: 'username-read' });
    return undefined;
  }
  const cached = wallet.identity;
  if (cached?.identityAccountId === identityAccountId && cached.liteUsername === name) {
    return undefined;
  }
  try {
    await updateSharedLocalWalletIdentity(SITE_ID, { identityAccountId, liteUsername: name });
  } catch (error) {
    // Reported here, once for every core sharing this read. The name still holds for this page, and the next boot
    // reads it again.
    reportLocalWalletFailure(error, 'identity-save');
  }
  const activatedWith = cached?.liteUsername ?? null;
  return name === activatedWith ? undefined : name;
}

/** Undefined when there is nothing to re-activate, otherwise the new name, null when the account has none. */
export function refreshLiteUsername(wallet: LocalWalletBoot): Promise<string | null | undefined> {
  refresh ??= readChange(wallet);
  return refresh;
}

export const __testing = {
  setReader(reader: ReadLiteUsername): void {
    readLiteUsername = reader;
  },
};
