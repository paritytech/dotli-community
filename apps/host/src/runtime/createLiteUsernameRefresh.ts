// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The lite username the network holds for the local wallet's identity account, read until the network answers once
// per page and cached in the shared wallet record so the next boot activates with it.

import { createReporter } from '@dotli/metrics';
import type { LocalWalletIdentity } from '@dotli/protocol';
import { createAsyncTaskPool, fromHex } from '@dotli/shared';
import { loadPolkadotApi } from '../lazy.js';
import { parsePolkadotAccount } from './polkadotAccount.js';
import { readPeopleUsernames } from './readPeopleUsernames.js';
import { siteWallet } from './session/siteWallet.js';
import { reportLocalWalletFailure, walletLocalActivateMetric, type LocalWalletFailureReason } from './walletFailure.js';
import type { LocalWalletBoot } from './createWalletBoot.js';

const report = createReporter({ flow: 'wallet' });

type Params = {
  /**
   * The name People holds for the account, null when it has none. Rejects when People is unreachable or the read
   * fails.
   */
  readLiteUsername: (identityAccountId: string) => Promise<string | null>;
  /** Caches the identity in the shared wallet record for the next boot. Rejects when the record could not be saved. */
  saveIdentity: (identity: LocalWalletIdentity) => Promise<void>;
  /** Reports a save of the identity that failed. Never throws. */
  reportFailure: (error: unknown, reason: LocalWalletFailureReason) => void;
};

export type LiteUsernameRefresh = ReturnType<typeof createLiteUsernameRefresh>;

/** Returns a refresh that reads the network until it answers once. Never throws. */
export function createLiteUsernameRefresh({ readLiteUsername, saveIdentity, reportFailure }: Params) {
  // One read at a time, so every core on the page takes the first read's answer.
  const reads = createAsyncTaskPool({ poolSize: 1 });
  // Null until the network answers. A failed read tells nothing, so the next core reads again.
  let answer: { name: string | null | undefined } | null = null;

  async function readChange(
    wallet: LocalWalletBoot,
    identityAccountId: string,
  ): Promise<{ name: string | null | undefined } | null> {
    let name: string | null;
    try {
      name = await readLiteUsername(identityAccountId);
    } catch (error) {
      // People unreachable from this backend is the environment, and the cached name still serves.
      report.expected(error, {
        step: 'lite_username_read',
        metric: walletLocalActivateMetric,
        reason: 'username-read',
        message: '[dot.li wallet] lite username read failed, keeping the cached name:',
      });
      return null;
    }
    const cached = wallet.identity;
    if (cached?.identityAccountId === identityAccountId && cached.liteUsername === name) {
      return { name: undefined };
    }
    try {
      await saveIdentity({ identityAccountId, liteUsername: name });
    } catch (error) {
      // Reported here, once for every core sharing this read. The name still holds for this page, and the next boot
      // reads it again.
      reportFailure(error, 'identity-save');
    }
    const activatedWith = cached?.liteUsername ?? null;
    return { name: name === activatedWith ? undefined : name };
  }

  async function refresh(
    wallet: LocalWalletBoot,
    identityAccountId: Promise<string>,
  ): Promise<string | null | undefined> {
    // Awaited outside the queue, so a core that goes down before reporting never holds up another core's read.
    const account = await identityAccountId;
    return reads.call(async () => {
      answer ??= await readChange(wallet, account);
      return answer?.name;
    });
  }

  return {
    /**
     * Settles with undefined when there is nothing to re-activate, otherwise with the new name, null when the account
     * has none. `identityAccountId` is the account the calling core reported for its session. It does not reject: a
     * failed read settles with undefined, and a failed save is reported.
     */
    refresh,
  };
}

/** The page's refresh, shared by its local wallet cores. */
export const liteUsernameRefresh: LiteUsernameRefresh = createLiteUsernameRefresh({
  readLiteUsername: readFromPeople,
  saveIdentity: identity => siteWallet.updateIdentity(identity),
  reportFailure: reportLocalWalletFailure,
});

async function readFromPeople(identityAccountId: string): Promise<string | null> {
  const polkadotApi = await loadPolkadotApi();
  const usernames = await readPeopleUsernames(
    parsePolkadotAccount(polkadotApi.AccountId().dec(fromHex(identityAccountId))),
  );
  return usernames?.lite ?? null;
}
